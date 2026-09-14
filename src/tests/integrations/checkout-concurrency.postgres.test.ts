import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCheckoutComposition } from '../../composition/checkout-composition.js';
import { createPrismaClient } from '../../db/prisma.js';
import { CheckoutIdempotencyError } from '../../modules/checkout/checkout.core.js';
import type { CheckoutTransactionPorts } from '../../modules/checkout/checkout.port.js';
import { resetDb } from '../support/helpers.js';

const databaseUrl = process.env.CHECKOUT_RACE_DATABASE_URL;

function connectionUrl(applicationName: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

const first = databaseUrl ? createPrismaClient(connectionUrl('checkout-race-first')) : null;
const second = databaseUrl ? createPrismaClient(connectionUrl('checkout-race-second')) : null;
const monitor = databaseUrl ? createPrismaClient(connectionUrl('checkout-race-monitor')) : null;

beforeEach(async () => {
  if (first) await resetDb(first);
});

afterAll(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect(), monitor?.$disconnect()]);
});

function requireClients() {
  if (!first || !second || !monitor) {
    throw new Error('CHECKOUT_RACE_DATABASE_URL is required');
  }
  return { first, second, monitor };
}

async function waitForSecondAdvisoryLockWait(): Promise<void> {
  const clients = requireClients();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the lock-wait path
    const [state] = await clients.monitor.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks lock
        JOIN pg_stat_activity activity ON activity.pid = lock.pid
        WHERE lock.locktype = 'advisory'
          AND NOT lock.granted
          AND activity.application_name = 'checkout-race-second'
      ) AS waiting
    `;
    if (state?.waiting) return;
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the lock-wait path
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('second checkout never waited on an advisory lock');
}

function contractBarrier() {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    decorate: (next: CheckoutTransactionPorts['contract']['create']) =>
      async (formation: Parameters<CheckoutTransactionPorts['contract']['create']>[0]) => {
        markReached();
        await released;
        return next(formation);
      },
  };
}

async function seedCheckoutWorld(suffix: string) {
  if (!first) throw new Error('CHECKOUT_RACE_DATABASE_URL is required');
  const buyer = await first.user.create({ data: { email: `race-buyer-${suffix}@example.com` } });
  const worker = await first.user.create({ data: { email: `race-worker-${suffix}@example.com` } });
  const commissionType = await first.commissionType.create({
    data: { workerId: worker.id, title: 'portrait', price: 500 },
  });
  const slot = await first.commissionSlot.create({ data: { workerId: worker.id } });
  const order = await first.order.create({
    data: {
      buyerId: buyer.id,
      commissionTypeId: commissionType.id,
      slotId: slot.id,
      titleSnapshot: commissionType.title,
      amount: commissionType.price,
    },
  });
  const payment = await first.orderPayment.create({
    data: { orderId: order.id, referenceId: `race:${suffix}`, amount: order.amount },
  });
  const holder = await first.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const account = await first.financialAccount.create({
    data: { currency: 'POINT', purpose: 'AVAILABLE', holderId: holder.id },
  });
  await first.pointLot.create({
    data: {
      accountId: account.id,
      sourceKind: 'PAID',
      originalAmount: 1_000,
      remainingAmount: 1_000,
    },
  });
  return { buyer, payment };
}

describe.skipIf(!databaseUrl)('checkout concurrency on PostgreSQL', () => {
  it('replays a concurrent retry after waiting for the first payment commit', async () => {
    const clients = requireClients();
    const world = await seedCheckoutWorld('same-payment');
    const input = {
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'same-payment-key',
    };

    const barrier = contractBarrier();
    const firstRequest = createCheckoutComposition(
      { rw: clients.first, ro: clients.first },
      { decorateContractCreate: barrier.decorate },
    ).payOrder(input);
    await barrier.reached;
    const secondRequest = createCheckoutComposition({ rw: clients.second, ro: clients.second })
      .payOrder(input);
    const waitError = await waitForSecondAdvisoryLockWait().then(
      () => null,
      (error: unknown) => error,
    );
    barrier.release();
    const results = await Promise.all([firstRequest, secondRequest]);
    if (waitError) throw waitError;

    expect(results.map((result) => result.replayed).toSorted((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(results.map(({ replayed: _replayed, ...result }) => result)).toEqual([
      expect.objectContaining({ orderPaymentId: world.payment.id }),
      expect.objectContaining({ orderPaymentId: world.payment.id }),
    ]);
    expect(results[0].contractId).toBe(results[1].contractId);
    expect(results[0].reservationId).toBe(results[1].reservationId);
    expect(await clients.first.financialReservation.count()).toBe(1);
    expect(await clients.first.contract.count()).toBe(1);
    expect(await clients.first.checkoutCommand.count()).toBe(1);
  });

  it('classifies a concurrently reused command key as an idempotency mismatch', async () => {
    const clients = requireClients();
    const left = await seedCheckoutWorld('left');
    const right = await seedCheckoutWorld('right');
    const barrier = contractBarrier();
    const firstRequest = createCheckoutComposition(
      { rw: clients.first, ro: clients.first },
      { decorateContractCreate: barrier.decorate },
    ).payOrder({
        orderPaymentId: left.payment.id,
        actorId: left.buyer.id,
        commandKey: 'shared-command-key',
      });
    await barrier.reached;
    const secondRequest = createCheckoutComposition({ rw: clients.second, ro: clients.second })
      .payOrder({
        orderPaymentId: right.payment.id,
        actorId: right.buyer.id,
        commandKey: 'shared-command-key',
      });
    const waitError = await waitForSecondAdvisoryLockWait().then(
      () => null,
      (error: unknown) => error,
    );
    barrier.release();
    const outcomes = await Promise.allSettled([firstRequest, secondRequest]);
    if (waitError) throw waitError;

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(CheckoutIdempotencyError);
    expect(await clients.first.financialReservation.count()).toBe(1);
    expect(await clients.first.contract.count()).toBe(1);
    expect(await clients.first.checkoutCommand.count()).toBe(1);
  });

  it('rejects a reservation basis update while its first transfer is uncommitted', async () => {
    const clients = requireClients();
    const holder = await clients.first.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: 'concurrent-ledger-owner' },
    });
    const available = await clients.first.financialAccount.create({
      data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
    });
    const reservation = await clients.first.financialReservation.create({
      data: {
        referenceId: 'concurrent-ledger-payment',
        bindingNamespace: 'order-payment',
        bindingKey: 'concurrent-ledger-payment',
        holderId: holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });
    const escrow = await clients.first.financialAccount.create({
      data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
    });
    const lot = await clients.first.pointLot.create({
      data: {
        accountId: available.id,
        sourceKind: 'PAID',
        originalAmount: 100,
        remainingAmount: 100,
      },
    });
    let markTransferInserted!: () => void;
    let releaseTransfer!: () => void;
    const transferInserted = new Promise<void>((resolve) => {
      markTransferInserted = resolve;
    });
    const transferRelease = new Promise<void>((resolve) => {
      releaseTransfer = resolve;
    });
    const transferRequest = clients.first.$transaction(async (tx) => {
      await tx.pointLot.update({ where: { id: lot.id }, data: { remainingAmount: 0 } });
      const transfer = await tx.financialTransfer.create({
        data: {
          reservationId: reservation.id,
          fromAccountId: available.id,
          toAccountId: escrow.id,
          amount: 100,
        },
      });
      await tx.financialTransferAllocation.create({
        data: { transferId: transfer.id, lotId: lot.id, amount: 100 },
      });
      markTransferInserted();
      await transferRelease;
    });

    await transferInserted;
    const updateError = await clients.second.financialReservation
      .update({ where: { id: reservation.id }, data: { targetAmount: 99 } })
      .then(
        () => null,
        (error: unknown) => error,
      );
    releaseTransfer();
    await transferRequest;

    expect(String(updateError)).toMatch(/FinancialReservation_basis_immutable/);
    expect(
      await clients.first.financialReservation.findUniqueOrThrow({
        where: { id: reservation.id },
      }),
    ).toMatchObject({ targetAmount: 100 });
    expect(await clients.first.financialTransfer.count()).toBe(1);
  });
});
