import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCheckoutComposition } from '../../composition/checkout-composition.js';
import { createPrismaClient } from '../../db/prisma.js';
import { CheckoutIdempotencyError } from '../../modules/checkout/checkout.core.js';
import { resetDb } from '../support/helpers.js';

const databaseUrl = process.env.CHECKOUT_RACE_DATABASE_URL;
const first = databaseUrl ? createPrismaClient(databaseUrl) : null;
const second = databaseUrl ? createPrismaClient(databaseUrl) : null;

beforeEach(async () => {
  if (first) await resetDb(first);
});

afterAll(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
});

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
    const world = await seedCheckoutWorld('same-payment');
    const input = {
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'same-payment-key',
    };

    const results = await Promise.all([
      createCheckoutComposition({ rw: first!, ro: first! }).payOrder(input),
      createCheckoutComposition({ rw: second!, ro: second! }).payOrder(input),
    ]);

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
    expect(await first!.financialReservation.count()).toBe(1);
    expect(await first!.contract.count()).toBe(1);
    expect(await first!.checkoutCommand.count()).toBe(1);
  });

  it('classifies a concurrently reused command key as an idempotency mismatch', async () => {
    const left = await seedCheckoutWorld('left');
    const right = await seedCheckoutWorld('right');
    const outcomes = await Promise.allSettled([
      createCheckoutComposition({ rw: first!, ro: first! }).payOrder({
        orderPaymentId: left.payment.id,
        actorId: left.buyer.id,
        commandKey: 'shared-command-key',
      }),
      createCheckoutComposition({ rw: second!, ro: second! }).payOrder({
        orderPaymentId: right.payment.id,
        actorId: right.buyer.id,
        commandKey: 'shared-command-key',
      }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(CheckoutIdempotencyError);
    expect(await first!.financialReservation.count()).toBe(1);
    expect(await first!.contract.count()).toBe(1);
    expect(await first!.checkoutCommand.count()).toBe(1);
  });
});
