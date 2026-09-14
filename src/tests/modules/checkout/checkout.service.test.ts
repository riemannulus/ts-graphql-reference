import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCheckoutComposition } from '../../../composition/checkout-composition.js';
import { resetDb, makeTestPrisma } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function seedCheckoutWorld(opts: { balance?: number; slotState?: string } = {}) {
  const buyer = await prisma.user.create({ data: { email: 'checkout-buyer@example.com' } });
  const worker = await prisma.user.create({ data: { email: 'checkout-worker@example.com' } });
  const commissionType = await prisma.commissionType.create({
    data: { workerId: worker.id, title: 'portrait', price: 500 },
  });
  const slot = await prisma.commissionSlot.create({
    data: { workerId: worker.id, state: opts.slotState ?? 'AVAILABLE' },
  });
  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      commissionTypeId: commissionType.id,
      slotId: slot.id,
      titleSnapshot: commissionType.title,
      amount: commissionType.price,
    },
  });
  const payment = await prisma.orderPayment.create({
    data: {
      orderId: order.id,
      referenceId: `order-payment:${order.id}`,
      amount: order.amount,
    },
  });
  const holder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const account = await prisma.financialAccount.create({
    data: { currency: 'POINT', purpose: 'AVAILABLE', holderId: holder.id },
  });
  const lot = await prisma.pointLot.create({
    data: {
      accountId: account.id,
      sourceKind: 'PAID',
      originalAmount: opts.balance ?? 1_000,
      remainingAmount: opts.balance ?? 1_000,
    },
  });
  return { buyer, worker, order, payment, holder, account, lot, slot };
}

describe('CheckoutService.payOrder', () => {
  it('atomically reserves POINT and forms exactly one Contract', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutComposition(db);

    const result = await checkout.payOrder({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'pay-1',
    });

    expect(result).toEqual({
      orderId: world.order.id,
      orderPaymentId: world.payment.id,
      contractId: 1,
      reservationId: 1,
      replayed: false,
    });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: world.order.id } })).toMatchObject({
      state: 'PAID',
    });
    expect(
      await prisma.orderPayment.findUniqueOrThrow({ where: { id: world.payment.id } }),
    ).toMatchObject({ state: 'PAID' });
    expect(await prisma.commissionSlot.findUniqueOrThrow({ where: { id: world.slot.id } })).toMatchObject({
      state: 'OCCUPIED',
    });
    expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.financialAccount.count({ where: { purpose: 'ESCROW' } })).toBe(1);
    expect(await prisma.financialTransfer.count()).toBe(1);
    expect(await prisma.financialTransferAllocation.count()).toBe(1);
    expect(await prisma.orderFinancialLink.count()).toBe(1);
    expect(await prisma.checkoutCommand.count()).toBe(1);
  });

  it('rolls back every financial and product write when Contract creation fails', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutComposition(db, {
      createContract: async () => {
        throw new Error('forced contract failure');
      },
    });

    await expect(
      checkout.payOrder({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'pay-fails',
      }),
    ).rejects.toThrow('forced contract failure');

    expect(await prisma.financialReservation.count()).toBe(0);
    expect(await prisma.financialTransfer.count()).toBe(0);
    expect(await prisma.orderFinancialLink.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.checkoutCommand.count()).toBe(0);
    expect(await prisma.financialAccount.count({ where: { purpose: 'ESCROW' } })).toBe(0);
    expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 1_000,
    });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: world.order.id } })).toMatchObject({
      state: 'REQUESTED',
    });
    expect(
      await prisma.orderPayment.findUniqueOrThrow({ where: { id: world.payment.id } }),
    ).toMatchObject({ state: 'PENDING' });
    expect(await prisma.commissionSlot.findUniqueOrThrow({ where: { id: world.slot.id } })).toMatchObject({
      state: 'AVAILABLE',
    });
  });
});
