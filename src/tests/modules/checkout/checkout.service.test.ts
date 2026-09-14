import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CheckoutIdempotencyError, CheckoutStateError } from '../../../modules/checkout/checkout.core.js';
import { createCheckoutService } from '../../../modules/checkout/checkout.service.js';
import { InsufficientFinancialFundsError } from '../../../modules/financial-ledger/financial-ledger.core.js';
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

async function withRejectedContractInsert(run: () => Promise<void>): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION checkout_test_reject_contract() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced contract failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER checkout_test_reject_contract
    BEFORE INSERT ON "Contract"
    FOR EACH ROW EXECUTE FUNCTION checkout_test_reject_contract()
  `);
  try {
    await run();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER checkout_test_reject_contract ON "Contract"');
    await prisma.$executeRawUnsafe('DROP FUNCTION checkout_test_reject_contract()');
  }
}

describe('CheckoutService.payOrder', () => {
  it('atomically reserves POINT and forms exactly one Contract', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutService(db);

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

  it('preserves exact FIFO lot provenance across a multi-lot reservation', async () => {
    const world = await seedCheckoutWorld({ balance: 200 });
    const secondLot = await prisma.pointLot.create({
      data: {
        accountId: world.account.id,
        sourceKind: 'FREE',
        originalAmount: 400,
        remainingAmount: 400,
      },
    });
    const checkout = createCheckoutService(db);

    const result = await checkout.payOrder({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'multi-lot',
    });

    const reservation = await prisma.financialReservation.findUniqueOrThrow({
      where: { id: result.reservationId },
      include: {
        escrowAccount: true,
        transfer: { include: { allocations: { orderBy: { lotId: 'asc' } } } },
        orderLink: true,
      },
    });
    expect(reservation).toMatchObject({
      referenceId: world.payment.referenceId,
      bindingNamespace: 'order-payment',
      bindingKey: String(world.payment.id),
      holderId: world.holder.id,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      targetAmount: 500,
      state: 'HELD',
      orderLink: { orderPaymentId: world.payment.id },
    });
    expect(reservation.escrowAccount).toMatchObject({
      currency: 'POINT',
      purpose: 'ESCROW',
      holderId: null,
      reservationId: result.reservationId,
    });
    expect(reservation.transfer).toMatchObject({
      reservationId: result.reservationId,
      fromAccountId: world.account.id,
      toAccountId: reservation.escrowAccount!.id,
      amount: 500,
      allocations: [
        { lotId: world.lot.id, amount: 200 },
        { lotId: secondLot.id, amount: 300 },
      ],
    });
    expect(
      await prisma.pointLot.findMany({
        where: { id: { in: [world.lot.id, secondLot.id] } },
        orderBy: { id: 'asc' },
        select: { id: true, remainingAmount: true },
      }),
    ).toEqual([
      { id: world.lot.id, remainingAmount: 0 },
      { id: secondLot.id, remainingAmount: 100 },
    ]);
  });

  it('rolls back every financial and product write when Contract creation fails', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutService(db);

    await withRejectedContractInsert(async () => {
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

  it('replays the stored result for the same command without another economic effect', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutService(db);
    const input = { orderPaymentId: world.payment.id, actorId: world.buyer.id, commandKey: 'same' };

    const first = await checkout.payOrder(input);
    const second = await checkout.payOrder(input);

    expect(second).toEqual({ ...first, replayed: true });
    expect(await prisma.checkoutCommand.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
  });

  it('rejects reusing a command key for a different payload', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutService(db);
    await checkout.payOrder({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'collision',
    });

    await expect(
      checkout.payOrder({
        orderPaymentId: world.payment.id,
        actorId: world.worker.id,
        commandKey: 'collision',
      }),
    ).rejects.toBeInstanceOf(CheckoutIdempotencyError);
    expect(await prisma.checkoutCommand.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
  });

  it('reuses the economic result when a different command key retries a paid payment', async () => {
    const world = await seedCheckoutWorld();
    const checkout = createCheckoutService(db);
    const first = await checkout.payOrder({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'first-key',
    });

    const replay = await checkout.payOrder({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'second-key',
    });

    expect(replay).toEqual({ ...first, replayed: true });
    expect(await prisma.checkoutCommand.count()).toBe(2);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
  });

  it('rejects insufficient POINT without any partial write', async () => {
    const world = await seedCheckoutWorld({ balance: 499 });
    const checkout = createCheckoutService(db);

    await expect(
      checkout.payOrder({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'insufficient',
      }),
    ).rejects.toBeInstanceOf(InsufficientFinancialFundsError);
    expect(await prisma.financialReservation.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.checkoutCommand.count()).toBe(0);
    expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 499,
    });
  });

  it('rejects an unavailable slot before reserving funds', async () => {
    const world = await seedCheckoutWorld({ slotState: 'OCCUPIED' });
    const checkout = createCheckoutService(db);

    await expect(
      checkout.payOrder({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'occupied',
      }),
    ).rejects.toBeInstanceOf(CheckoutStateError);
    expect(await prisma.financialReservation.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.checkoutCommand.count()).toBe(0);
  });
});
