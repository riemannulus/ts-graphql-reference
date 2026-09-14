import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../db/prisma.js';
import { CommissionCheckoutIdempotencyError } from '../../modules/commission-checkout/commission-checkout.core.js';
import { createCommissionCheckoutService } from '../../modules/commission-checkout/commission-checkout.service.js';
import { resetDb } from '../support/helpers.js';

const databaseUrl = process.env.COMMISSION_CHECKOUT_RACE_DATABASE_URL;
const CONTRACT_BARRIER_CLASS_ID = 2_000_000_000;
const CONTRACT_BARRIER_OBJECT_ID = 2_000_000_000;

function connectionUrl(applicationName: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

const first = databaseUrl ? createPrismaClient(connectionUrl('commission-checkout-race-first')) : null;
const second = databaseUrl ? createPrismaClient(connectionUrl('commission-checkout-race-second')) : null;
const monitor = databaseUrl ? createPrismaClient(connectionUrl('commission-checkout-race-monitor')) : null;

beforeAll(async () => {
  if (!first) return;
  await first.$executeRawUnsafe('DROP TRIGGER IF EXISTS commission_checkout_test_contract_barrier ON "Contract"');
  await first.$executeRawUnsafe('DROP FUNCTION IF EXISTS commission_checkout_test_contract_barrier()');
  await first.$executeRawUnsafe(`
    CREATE FUNCTION commission_checkout_test_contract_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('application_name') = 'commission-checkout-race-first' THEN
        PERFORM pg_advisory_xact_lock(${CONTRACT_BARRIER_CLASS_ID}, ${CONTRACT_BARRIER_OBJECT_ID});
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await first.$executeRawUnsafe(`
    CREATE TRIGGER commission_checkout_test_contract_barrier
    BEFORE INSERT ON "Contract"
    FOR EACH ROW EXECUTE FUNCTION commission_checkout_test_contract_barrier()
  `);
});

beforeEach(async () => {
  if (first) await resetDb(first);
});

afterAll(async () => {
  if (first) {
    await first.$executeRawUnsafe('DROP TRIGGER IF EXISTS commission_checkout_test_contract_barrier ON "Contract"');
    await first.$executeRawUnsafe('DROP FUNCTION IF EXISTS commission_checkout_test_contract_barrier()');
  }
  await Promise.all([first?.$disconnect(), second?.$disconnect(), monitor?.$disconnect()]);
});

function requireClients() {
  if (!first || !second || !monitor) {
    throw new Error('COMMISSION_CHECKOUT_RACE_DATABASE_URL is required');
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
          AND activity.application_name = 'commission-checkout-race-second'
      ) AS waiting
    `;
    if (state?.waiting) return;
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the lock-wait path
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('second commission checkout never waited on an advisory lock');
}

async function waitForContractBarrier(): Promise<void> {
  const clients = requireClients();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the DB-trigger barrier
    const [state] = await clients.monitor.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks lock
        JOIN pg_stat_activity activity ON activity.pid = lock.pid
        WHERE lock.locktype = 'advisory'
          AND lock.classid = 2000000000
          AND lock.objid = 2000000000
          AND NOT lock.granted
          AND activity.application_name = 'commission-checkout-race-first'
      ) AS waiting
    `;
    if (state?.waiting) return;
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the DB-trigger barrier
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('first commission checkout never reached the Contract insert barrier');
}

async function contractBarrier() {
  const blocker = new Client({ connectionString: connectionUrl('commission-checkout-race-barrier') });
  await blocker.connect();
  await blocker.query('SELECT pg_advisory_lock($1, $2)', [
    CONTRACT_BARRIER_CLASS_ID,
    CONTRACT_BARRIER_OBJECT_ID,
  ]);
  let released = false;
  return {
    waitUntilReached: waitForContractBarrier,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await blocker.query('SELECT pg_advisory_unlock($1, $2)', [
          CONTRACT_BARRIER_CLASS_ID,
          CONTRACT_BARRIER_OBJECT_ID,
        ]);
      } finally {
        await blocker.end();
      }
    },
  };
}

async function seedCommissionCheckoutWorld(
  suffix: string,
  existingBuyer?: { id: number },
) {
  if (!first) throw new Error('COMMISSION_CHECKOUT_RACE_DATABASE_URL is required');
  const buyer =
    existingBuyer ??
    (await first.user.create({ data: { email: `race-buyer-${suffix}@example.com` } }));
  const worker = await first.user.create({ data: { email: `race-worker-${suffix}@example.com` } });
  const commissionType = await first.commissionType.create({
    data: { workerId: worker.id, title: 'portrait', price: 500 },
  });
  const slot = await first.commissionSlot.create({ data: { workerId: worker.id } });
  const flow = await first.transactionFlow.create({
    data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
  });
  const order = await first.order.create({
    data: {
      flowId: flow.id,
      buyerId: buyer.id,
      commissionTypeId: commissionType.id,
      slotId: slot.id,
      titleSnapshot: commissionType.title,
      amount: commissionType.price,
    },
  });
  const payment = await first.orderPayment.create({
    data: { orderId: order.id, flowId: flow.id, amount: order.amount },
  });
  if (!existingBuyer) {
    const holder = await first.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
    });
    const account = await first.financialAccount.create({
      data: { currency: 'POINT', purpose: 'AVAILABLE', holderId: holder.id },
    });
    await first.financialLot.create({
      data: {
        accountId: account.id,
        sourceKind: 'PAID',
        originalAmount: 1_000,
        remainingAmount: 1_000,
      },
    });
  }
  return { buyer, payment };
}

describe.skipIf(!databaseUrl)('commission checkout concurrency on PostgreSQL', () => {
  it('replays a concurrent retry after waiting for the first payment commit', async () => {
    const clients = requireClients();
    const world = await seedCommissionCheckoutWorld('same-payment');
    const input = {
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'same-payment-key',
    };

    const barrier = await contractBarrier();
    try {
      const firstRequest = createCommissionCheckoutService({ rw: clients.first, ro: clients.first }).complete(input);
      await barrier.waitUntilReached();
      const secondRequest = createCommissionCheckoutService({ rw: clients.second, ro: clients.second }).complete(input);
      const waitError = await waitForSecondAdvisoryLockWait().then(
        () => null,
        (error: unknown) => error,
      );
      await barrier.release();
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
      expect(await clients.first.financialCommandRun.count()).toBe(1);
    } finally {
      await barrier.release();
    }
  });

  it('classifies a concurrently reused command key as an idempotency mismatch', async () => {
    const clients = requireClients();
    const left = await seedCommissionCheckoutWorld('left');
    const right = await seedCommissionCheckoutWorld('right', left.buyer);
    const barrier = await contractBarrier();
    try {
      const firstRequest = createCommissionCheckoutService({ rw: clients.first, ro: clients.first }).complete({
        orderPaymentId: left.payment.id,
        actorId: left.buyer.id,
        commandKey: 'shared-command-key',
      });
      await barrier.waitUntilReached();
      const secondRequest = createCommissionCheckoutService({ rw: clients.second, ro: clients.second }).complete({
        orderPaymentId: right.payment.id,
        actorId: right.buyer.id,
        commandKey: 'shared-command-key',
      });
      const waitError = await waitForSecondAdvisoryLockWait().then(
        () => null,
        (error: unknown) => error,
      );
      await barrier.release();
      const outcomes = await Promise.allSettled([firstRequest, secondRequest]);
      if (waitError) throw waitError;

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(CommissionCheckoutIdempotencyError);
      expect(await clients.first.financialReservation.count()).toBe(1);
      expect(await clients.first.contract.count()).toBe(1);
      expect(await clients.first.financialCommandRun.count()).toBe(1);
    } finally {
      await barrier.release();
    }
  });

  it('rejects a reservation basis update while its first transfer is uncommitted', async () => {
    const clients = requireClients();
    const principal = await clients.first.user.create({
      data: { email: 'concurrent-ledger-principal@example.com' },
    });
    const flow = await clients.first.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    const command = await clients.first.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: principal.id,
        idempotencyKey: 'concurrent-ledger-command',
        payloadHash: 'test',
        subjectNamespace: 'test',
        subjectKey: 'concurrent-ledger',
      },
    });
    const operation = await clients.first.financialOperation.create({
      data: { flowId: flow.id, kind: 'PAY', originatingCommandId: command.id },
    });
    const action = await clients.first.financialTransferAction.create({
      data: { operationId: operation.id, flowId: flow.id },
    });
    const holder = await clients.first.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: 'concurrent-ledger-owner' },
    });
    const available = await clients.first.financialAccount.create({
      data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
    });
    const reservation = await clients.first.financialReservation.create({
      data: {
        flowId: flow.id,
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
    const lot = await clients.first.financialLot.create({
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
      await tx.financialLot.update({ where: { id: lot.id }, data: { remainingAmount: 0 } });
      const transfer = await tx.financialTransfer.create({
        data: {
          reservationId: reservation.id,
          flowId: flow.id,
          fromAccountId: available.id,
          toAccountId: escrow.id,
          amount: 100,
          actionId: action.id,
        },
      });
      await tx.financialTransferAllocation.create({
        data: { transferId: transfer.id, fromAccountId: transfer.fromAccountId, currency: transfer.currency, lotId: lot.id, amount: 100 },
      });
      markTransferInserted();
      await transferRelease;
      await tx.financialCommandRun.update({
        where: { id: command.id },
        data: { resultOperationId: operation.id },
      });
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
