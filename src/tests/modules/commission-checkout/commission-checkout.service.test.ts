import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CommissionCheckoutActorError,
  CommissionCheckoutIdempotencyError,
  CommissionCheckoutStateError,
} from '../../../modules/commission-checkout/commission-checkout.core.js';
import { createCommissionCheckoutService } from '../../../modules/commission-checkout/commission-checkout.service.js';
import { InsufficientFinancialFundsError } from '../../../modules/financial-ledger/financial-ledger.core.js';
import { resetDb, makeTestPrisma } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function seedCommissionCheckoutWorld(opts: { balance?: number; slotState?: string } = {}) {
  const buyer = await prisma.user.create({ data: { email: 'commission-checkout-buyer@example.com' } });
  const worker = await prisma.user.create({ data: { email: 'commission-checkout-worker@example.com' } });
  const commissionType = await prisma.commissionType.create({
    data: { workerId: worker.id, title: 'portrait', price: 500 },
  });
  const slot = await prisma.commissionSlot.create({
    data: { workerId: worker.id, state: opts.slotState ?? 'AVAILABLE' },
  });
  const flow = await prisma.transactionFlow.create({
    data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
  });
  const order = await prisma.order.create({
    data: {
      flowId: flow.id,
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
      flowId: flow.id,
      amount: order.amount,
    },
  });
  const holder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const account = await prisma.financialAccount.create({
    data: { currency: 'POINT', purpose: 'AVAILABLE', holderId: holder.id },
  });
  const lot = await prisma.financialLot.create({
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
    CREATE FUNCTION commission_checkout_test_reject_contract() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced contract failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER commission_checkout_test_reject_contract
    BEFORE INSERT ON "Contract"
    FOR EACH ROW EXECUTE FUNCTION commission_checkout_test_reject_contract()
  `);
  try {
    await run();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER commission_checkout_test_reject_contract ON "Contract"');
    await prisma.$executeRawUnsafe('DROP FUNCTION commission_checkout_test_reject_contract()');
  }
}

describe('CommissionCheckoutService.complete', () => {
  it('atomically reserves POINT and forms exactly one Contract', async () => {
    const world = await seedCommissionCheckoutWorld();
    const commissionCheckout = createCommissionCheckoutService(db);

    const result = await commissionCheckout.complete({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'pay-1',
    });

    expect(result).toEqual({
      orderId: world.order.id,
      orderPaymentId: world.payment.id,
      contractId: 1,
      reservationId: 1,
      referenceId: expect.stringMatching(/^COMMISSION-[0-9a-f-]{36}$/),
      commandId: expect.stringMatching(/^CMD-PAY-[0-9a-f-]{36}$/),
      operationId: expect.stringMatching(/^OP-PAY-[0-9a-f-]{36}$/),
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
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.financialAccount.count({ where: { purpose: 'ESCROW' } })).toBe(1);
    expect(await prisma.financialTransfer.count()).toBe(1);
    expect(await prisma.financialTransferAllocation.count()).toBe(1);
    expect(await prisma.orderFinancialLink.count()).toBe(1);
    expect(await prisma.financialCommandRun.count()).toBe(1);
    expect(await prisma.financialOperation.count()).toBe(1);
    expect(await prisma.financialTransferAction.count()).toBe(1);
  });

  it('preserves exact FIFO lot provenance across a multi-lot reservation', async () => {
    const world = await seedCommissionCheckoutWorld({ balance: 200 });
    const secondLot = await prisma.financialLot.create({
      data: {
        accountId: world.account.id,
        sourceKind: 'FREE',
        originalAmount: 400,
        remainingAmount: 400,
      },
    });
    const commissionCheckout = createCommissionCheckoutService(db);

    const result = await commissionCheckout.complete({
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
      flowId: world.order.flowId,
      bindingNamespace: 'commission-order-payment',
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
      await prisma.financialLot.findMany({
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
    const world = await seedCommissionCheckoutWorld();
    const commissionCheckout = createCommissionCheckoutService(db);

    await withRejectedContractInsert(async () => {
      await expect(
        commissionCheckout.complete({
          orderPaymentId: world.payment.id,
          actorId: world.buyer.id,
          commandKey: 'pay-fails',
        }),
      ).rejects.toThrow('forced contract failure');

      expect(await prisma.financialReservation.count()).toBe(0);
      expect(await prisma.financialTransfer.count()).toBe(0);
      expect(await prisma.orderFinancialLink.count()).toBe(0);
      expect(await prisma.contract.count()).toBe(0);
      expect(await prisma.financialCommandRun.count()).toBe(0);
      expect(await prisma.financialOperation.count()).toBe(0);
      expect(await prisma.financialTransferAction.count()).toBe(0);
      expect(await prisma.financialAccount.count({ where: { purpose: 'ESCROW' } })).toBe(0);
      expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
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
    const world = await seedCommissionCheckoutWorld();
    const commissionCheckout = createCommissionCheckoutService(db);
    const input = { orderPaymentId: world.payment.id, actorId: world.buyer.id, commandKey: 'same' };

    const first = await commissionCheckout.complete(input);
    const second = await commissionCheckout.complete(input);

    expect(second).toEqual({ ...first, replayed: true });
    expect(await prisma.financialCommandRun.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
  });

  it('scopes command keys by principal and rejects another actor at the Order boundary', async () => {
    const world = await seedCommissionCheckoutWorld();
    const commissionCheckout = createCommissionCheckoutService(db);
    await commissionCheckout.complete({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'collision',
    });

    await expect(
      commissionCheckout.complete({
        orderPaymentId: world.payment.id,
        actorId: world.worker.id,
        commandKey: 'collision',
      }),
    ).rejects.toBeInstanceOf(CommissionCheckoutActorError);
    expect(await prisma.financialCommandRun.count()).toBe(1);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
  });

  it('reuses the economic result when a different command key retries a paid payment', async () => {
    const world = await seedCommissionCheckoutWorld();
    const commissionCheckout = createCommissionCheckoutService(db);
    const first = await commissionCheckout.complete({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'first-key',
    });

    const replay = await commissionCheckout.complete({
      orderPaymentId: world.payment.id,
      actorId: world.buyer.id,
      commandKey: 'second-key',
    });

    expect(replay).toEqual({
      ...first,
      commandId: expect.stringMatching(/^CMD-PAY-[0-9a-f-]{36}$/),
      replayed: true,
    });
    expect(replay.commandId).not.toBe(first.commandId);
    expect(await prisma.financialCommandRun.count()).toBe(2);
    expect(await prisma.financialReservation.count()).toBe(1);
    expect(await prisma.contract.count()).toBe(1);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 500,
    });
  });

  it('classifies a command key already bound to another subject before loading it', async () => {
    const world = await seedCommissionCheckoutWorld();
    await prisma.financialCommandRun.create({
      data: {
        flowId: world.order.flowId,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: world.buyer.id,
        idempotencyKey: 'foreign-subject',
        payloadHash: 'different-payload',
        subjectNamespace: 'another-product',
        subjectKey: 'missing',
      },
    });

    await expect(
      createCommissionCheckoutService(db).complete({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'foreign-subject',
      }),
    ).rejects.toBeInstanceOf(CommissionCheckoutIdempotencyError);
  });

  it('rejects replay when a valid product subject is bound to another flow', async () => {
    const world = await seedCommissionCheckoutWorld();
    const otherFlow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    const command = await prisma.financialCommandRun.create({
      data: {
        flowId: otherFlow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: world.buyer.id,
        idempotencyKey: 'wrong-flow',
        payloadHash: createHash('sha256')
          .update(JSON.stringify([world.payment.id, world.buyer.id]))
          .digest('hex'),
        subjectNamespace: 'commission-order-payment',
        subjectKey: String(world.payment.id),
      },
    });
    const operation = await prisma.financialOperation.create({
      data: { flowId: otherFlow.id, kind: 'PAY', originatingCommandId: command.id },
    });
    const action = await prisma.financialTransferAction.create({
      data: { flowId: otherFlow.id, operationId: operation.id, operationKind: 'PAY' },
    });
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.financialReservation.create({
        data: {
          flowId: otherFlow.id,
          bindingNamespace: 'test-other-flow',
          bindingKey: String(world.payment.id),
          holderId: world.holder.id,
          purpose: 'COMMISSION_PAYMENT',
          currency: 'POINT',
          targetAmount: 500,
        },
      });
      const escrow = await tx.financialAccount.create({
        data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
      });
      await tx.financialLot.update({
        where: { id: world.lot.id },
        data: { remainingAmount: 500 },
      });
      const transfer = await tx.financialTransfer.create({
        data: {
          reservationId: reservation.id,
          flowId: otherFlow.id,
          currency: 'POINT',
          fromAccountId: world.account.id,
          toAccountId: escrow.id,
          amount: 500,
          actionId: action.id,
        },
      });
      await tx.financialTransferAllocation.create({
        data: {
          transferId: transfer.id,
          fromAccountId: world.account.id,
          currency: 'POINT',
          lotId: world.lot.id,
          amount: 500,
        },
      });
      await tx.financialCommandRun.update({
        where: { id: command.id },
        data: { resultOperationId: operation.id },
      });
    });

    await expect(
      createCommissionCheckoutService(db).complete({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'wrong-flow',
      }),
    ).rejects.toThrow(/belongs to flow/);
  });

  it('rejects insufficient POINT without any partial write', async () => {
    const world = await seedCommissionCheckoutWorld({ balance: 499 });
    const commissionCheckout = createCommissionCheckoutService(db);

    await expect(
      commissionCheckout.complete({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'insufficient',
      }),
    ).rejects.toBeInstanceOf(InsufficientFinancialFundsError);
    expect(await prisma.financialReservation.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.financialCommandRun.count()).toBe(0);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } })).toMatchObject({
      remainingAmount: 499,
    });
  });

  it('rejects an unavailable slot before reserving funds', async () => {
    const world = await seedCommissionCheckoutWorld({ slotState: 'OCCUPIED' });
    const commissionCheckout = createCommissionCheckoutService(db);

    await expect(
      commissionCheckout.complete({
        orderPaymentId: world.payment.id,
        actorId: world.buyer.id,
        commandKey: 'occupied',
      }),
    ).rejects.toBeInstanceOf(CommissionCheckoutStateError);
    expect(await prisma.financialReservation.count()).toBe(0);
    expect(await prisma.contract.count()).toBe(0);
    expect(await prisma.financialCommandRun.count()).toBe(0);
  });
});
