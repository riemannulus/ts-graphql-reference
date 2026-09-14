import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommissionSettlementService } from '../../../modules/commission-settlement/commission-settlement.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function seedPaidCommission(
  options: { funded?: boolean; orderAmount?: number; fundingActor?: 'buyer' | 'worker' } = {},
) {
  const funded = options.funded ?? true;
  const orderAmount = options.orderAmount ?? 500;
  const buyer = await prisma.user.create({ data: { email: 'settlement-buyer@example.com' } });
  const worker = await prisma.user.create({ data: { email: 'settlement-worker@example.com' } });
  const commissionType = await prisma.commissionType.create({
    data: { workerId: worker.id, title: 'portrait', price: 500 },
  });
  const slot = await prisma.commissionSlot.create({
    data: { workerId: worker.id, state: 'OCCUPIED' },
  });
  const flow = await prisma.transactionFlow.create({
    data: {
      kind: 'COMMISSION',
      policies: { createMany: { data: [{ commandKind: 'PAY' }, { commandKind: 'SETTLE' }] } },
    },
  });
  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      commissionTypeId: commissionType.id,
      slotId: slot.id,
      flowId: flow.id,
      titleSnapshot: commissionType.title,
      amount: orderAmount,
      state: 'PAID',
    },
  });
  const payment = await prisma.orderPayment.create({
    data: { orderId: order.id, flowId: flow.id, amount: 500, state: 'PAID' },
  });
  const contract = await prisma.contract.create({
    data: { orderId: order.id, flowId: flow.id, buyerId: buyer.id, workerId: worker.id },
  });
  const buyerHolder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const buyerAvailable = await prisma.financialAccount.create({
    data: { holderId: buyerHolder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  const buyerLot = await prisma.financialLot.create({
    data: {
      accountId: buyerAvailable.id,
      currency: 'POINT',
      sourceKind: 'PAID',
      originalAmount: 500,
      remainingAmount: 500,
    },
  });
  const reservation = await prisma.financialReservation.create({
    data: {
      flowId: flow.id,
      bindingNamespace: 'commission-order-payment',
      bindingKey: String(payment.id),
      holderId: buyerHolder.id,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      targetAmount: 500,
    },
  });
  const escrow = await prisma.financialAccount.create({
    data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
  });
  const payCommand = await prisma.financialCommandRun.create({
    data: {
      flowId: flow.id,
      flowKind: 'COMMISSION',
      kind: 'PAY',
      principalId: options.fundingActor === 'worker' ? worker.id : buyer.id,
      idempotencyKey: 'funding-pay',
      payloadHash: 'funding-pay',
      subjectNamespace: 'commission-order-payment',
      subjectKey: String(payment.id),
    },
  });
  const payOperation = await prisma.financialOperation.create({
    data: { flowId: flow.id, kind: 'PAY', originatingCommandId: payCommand.id },
  });
  const payAction = await prisma.financialTransferAction.create({
    data: { flowId: flow.id, operationId: payOperation.id, operationKind: 'PAY' },
  });
  if (funded) {
    await prisma.$transaction(async (tx) => {
      await tx.financialLot.update({
        where: { id: buyerLot.id },
        data: { remainingAmount: 0 },
      });
      const funding = await tx.financialTransfer.create({
        data: {
          reservationId: reservation.id,
          flowId: flow.id,
          currency: 'POINT',
          fromAccountId: buyerAvailable.id,
          toAccountId: escrow.id,
          amount: 500,
          actionId: payAction.id,
        },
      });
      await tx.financialTransferAllocation.create({
        data: {
          transferId: funding.id,
          fromAccountId: buyerAvailable.id,
          currency: 'POINT',
          lotId: buyerLot.id,
          amount: 500,
        },
      });
      await tx.financialCommandRun.update({
        where: { id: payCommand.id },
        data: { resultOperationId: payOperation.id },
      });
    });
  }
  await prisma.orderFinancialLink.create({
    data: { orderPaymentId: payment.id, flowId: flow.id, reservationId: reservation.id },
  });
  const workerHolder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
  });
  const incomeAvailable = await prisma.financialAccount.create({
    data: { holderId: workerHolder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
  });
  const platform = await prisma.financialHolder.create({
    data: { bindingNamespace: 'system', bindingKey: 'platform' },
  });
  const pointSettled = await prisma.financialAccount.create({
    data: { holderId: platform.id, currency: 'POINT', purpose: 'SETTLED' },
  });
  const incomeIssuer = await prisma.financialAccount.create({
    data: { holderId: platform.id, currency: 'INCOME', purpose: 'ISSUER' },
  });
  return {
    worker,
    workerHolder,
    flow,
    order,
    payment,
    contract,
    reservation,
    escrow,
    incomeAvailable,
    pointSettled,
    incomeIssuer,
  };
}

async function attemptRawSettlement(
  world: Awaited<ReturnType<typeof seedPaidCommission>>,
  options: { amount?: number; beneficiaryHolderId?: number; complete?: boolean } = {},
) {
  const amount = options.amount ?? 500;
  return prisma.$transaction(async (tx) => {
    const command = await tx.financialCommandRun.create({
      data: {
        flowId: world.flow.id,
        flowKind: 'COMMISSION',
        kind: 'SETTLE',
        principalId: world.worker.id,
        idempotencyKey: `raw-${amount}-${options.beneficiaryHolderId ?? 'worker'}-${options.complete ?? true}`,
        payloadHash: 'raw-settlement',
        subjectNamespace: 'commission-contract',
        subjectKey: String(world.contract.id),
      },
    });
    const operation = await tx.financialOperation.create({
      data: { flowId: world.flow.id, kind: 'SETTLE', originatingCommandId: command.id },
    });
    const action = await tx.financialSwapAction.create({
      data: {
        flowId: world.flow.id,
        operationId: operation.id,
        operationKind: 'SETTLE',
        reservationId: world.reservation.id,
        beneficiaryHolderId: options.beneficiaryHolderId ?? world.workerHolder.id,
      },
    });
    await tx.financialSwapLeg.createMany({
      data: [
        {
          actionId: action.id,
          flowId: world.flow.id,
          currency: 'POINT',
          fromAccountId: world.escrow.id,
          toAccountId: world.pointSettled.id,
          amount,
        },
        {
          actionId: action.id,
          flowId: world.flow.id,
          currency: 'INCOME',
          fromAccountId: world.incomeIssuer.id,
          toAccountId: world.incomeAvailable.id,
          amount,
        },
      ],
    });
    await tx.financialLot.create({
      data: {
        accountId: world.incomeAvailable.id,
        currency: 'INCOME',
        sourceKind: 'COMMISSION_SETTLEMENT',
        sourceOperationId: operation.id,
        sourceSwapActionId: action.id,
        sourceFlowId: world.flow.id,
        sourceFlowKind: 'COMMISSION',
        sourceOperationKind: 'SETTLE',
        originalAmount: amount,
        remainingAmount: amount,
      },
    });
    await tx.financialReservation.update({
      where: { id: world.reservation.id },
      data: { state: 'SETTLED' },
    });
    if (options.complete ?? true) {
      await tx.financialCommandRun.update({
        where: { id: command.id },
        data: { resultOperationId: operation.id },
      });
    }
    await tx.$executeRawUnsafe(
      'SET CONSTRAINTS "FinancialSwap_shape_check", "FinancialReservation_settlement_shape_check" IMMEDIATE',
    );
  });
}

describe('CommissionSettlementService.settle', () => {
  it('swaps escrowed POINT into a commission-sourced withdrawable INCOME lot', async () => {
    const world = await seedPaidCommission();
    const service = createCommissionSettlementService(db);

    const result = await service.settle({
      contractId: world.contract.id,
      actorId: world.worker.id,
      commandKey: 'settle-1',
    });

    expect(result).toEqual({
      contractId: world.contract.id,
      reservationId: world.reservation.id,
      incomeLotId: expect.any(Number),
      referenceId: expect.stringMatching(/^COMMISSION-[0-9a-f-]{36}$/),
      commandId: expect.stringMatching(/^CMD-SETTLE-[0-9a-f-]{36}$/),
      operationId: expect.stringMatching(/^OP-SETTLE-[0-9a-f-]{36}$/),
      replayed: false,
    });
    expect(
      await prisma.financialReservation.findUniqueOrThrow({
        where: { id: world.reservation.id },
        select: { state: true },
      }),
    ).toEqual({ state: 'SETTLED' });
    const lot = await prisma.financialLot.findUniqueOrThrow({ where: { id: result.incomeLotId } });
    expect(lot).toMatchObject({
      accountId: world.incomeAvailable.id,
      currency: 'INCOME',
      sourceKind: 'COMMISSION_SETTLEMENT',
      sourceFlowId: world.flow.id,
      sourceOperationKind: 'SETTLE',
      originalAmount: 500,
      remainingAmount: 500,
    });
    const swap = await prisma.financialSwapAction.findUniqueOrThrow({
      where: { operationId: lot.sourceOperationId! },
      include: { legs: { orderBy: { currency: 'asc' } } },
    });
    expect(swap.legs).toEqual([
      expect.objectContaining({
        currency: 'INCOME',
        fromAccountId: world.incomeIssuer.id,
        toAccountId: world.incomeAvailable.id,
        amount: 500,
      }),
      expect.objectContaining({
        currency: 'POINT',
        fromAccountId: world.escrow.id,
        toAccountId: world.pointSettled.id,
        amount: 500,
      }),
    ]);

    const replay = await service.settle({
      contractId: world.contract.id,
      actorId: world.worker.id,
      commandKey: 'settle-1',
    });
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await prisma.financialSwapAction.count()).toBe(1);
    expect(await prisma.financialLot.count({ where: { currency: 'INCOME' } })).toBe(1);
    await expect(
      prisma.financialLot.update({
        where: { id: result.incomeLotId },
        data: { sourceFlowKind: 'WITHDRAWAL' },
      }),
    ).rejects.toThrow(/FinancialLot_basis_immutable/);
    await expect(
      prisma.financialLot.update({
        where: { id: result.incomeLotId },
        data: { createdAt: new Date(0) },
      }),
    ).rejects.toThrow(/FinancialLot_basis_immutable/);
    await expect(
      prisma.financialLot.delete({ where: { id: result.incomeLotId } }),
    ).rejects.toThrow(/FinancialLot_append_only/);
    await expect(
      prisma.financialReservation.update({
        where: { id: world.reservation.id },
        data: { state: 'HELD' },
      }),
    ).rejects.toThrow(/FinancialReservation_state_transition/);
    await expect(
      prisma.financialHolder.update({
        where: { id: world.workerHolder.id },
        data: { bindingKey: 'other-user' },
      }),
    ).rejects.toThrow(/FinancialHolder_binding_immutable/);
    await expect(
      prisma.contract.update({
        where: { id: world.contract.id },
        data: { workerId: world.worker.id + 1 },
      }),
    ).rejects.toThrow(/Contract_append_only/);
    await expect(
      prisma.order.update({ where: { id: world.order.id }, data: { amount: 501 } }),
    ).rejects.toThrow(/Order_basis_immutable/);
    await expect(
      prisma.orderPayment.update({
        where: { id: world.payment.id },
        data: { state: 'PENDING' },
      }),
    ).rejects.toThrow(/OrderPayment_state_transition/);
    await expect(
      prisma.orderFinancialLink.delete({ where: { orderPaymentId: world.payment.id } }),
    ).rejects.toThrow(/OrderFinancialLink_append_only/);
  });

  it('records an alias command for a different retry key without another economic effect', async () => {
    const world = await seedPaidCommission();
    const service = createCommissionSettlementService(db);
    const first = await service.settle({
      contractId: world.contract.id,
      actorId: world.worker.id,
      commandKey: 'first-key',
    });
    const second = await service.settle({
      contractId: world.contract.id,
      actorId: world.worker.id,
      commandKey: 'second-key',
    });

    expect(second).toMatchObject({
      operationId: first.operationId,
      incomeLotId: first.incomeLotId,
      replayed: true,
    });
    expect(second.commandId).not.toBe(first.commandId);
    expect(await prisma.financialCommandRun.count({ where: { kind: 'SETTLE' } })).toBe(2);
    expect(await prisma.financialSwapAction.count()).toBe(1);
  });

  it('rejects a non-worker without writing settlement history', async () => {
    const world = await seedPaidCommission();
    const outsider = await prisma.user.create({ data: { email: 'settlement-outsider@example.com' } });
    await expect(
      createCommissionSettlementService(db).settle({
        contractId: world.contract.id,
        actorId: outsider.id,
        commandKey: 'outsider',
      }),
    ).rejects.toThrow(/contract worker/);
    expect(await prisma.financialCommandRun.count({ where: { kind: 'SETTLE' } })).toBe(0);
    expect(await prisma.financialSwapAction.count()).toBe(0);
  });

  it('rejects an unfunded or differently-sized commission before minting INCOME', async () => {
    const unfunded = await seedPaidCommission({ funded: false });
    await expect(
      createCommissionSettlementService(db).settle({
        contractId: unfunded.contract.id,
        actorId: unfunded.worker.id,
        commandKey: 'unfunded',
      }),
    ).rejects.toThrow(/Funded commission reservation/);
    expect(await prisma.financialLot.count({ where: { currency: 'INCOME' } })).toBe(0);

    await resetDb(prisma);
    const mismatched = await seedPaidCommission({ orderAmount: 501 });
    await expect(
      createCommissionSettlementService(db).settle({
        contractId: mismatched.contract.id,
        actorId: mismatched.worker.id,
        commandKey: 'mismatch',
      }),
    ).rejects.toThrow(/funded amount/);
    expect(await prisma.financialLot.count({ where: { currency: 'INCOME' } })).toBe(0);

    await resetDb(prisma);
    const wrongPrincipal = await seedPaidCommission({ fundingActor: 'worker' });
    await expect(
      createCommissionSettlementService(db).settle({
        contractId: wrongPrincipal.contract.id,
        actorId: wrongPrincipal.worker.id,
        commandKey: 'wrong-pay-principal',
      }),
    ).rejects.toThrow(/principal/);
    expect(await prisma.financialLot.count({ where: { currency: 'INCOME' } })).toBe(0);
  });

  it('rejects raw settlement with an incomplete command, wrong amount, or wrong beneficiary', async () => {
    const world = await seedPaidCommission();
    await expect(attemptRawSettlement(world, { complete: false })).rejects.toThrow(
      /FinancialSwap_shape_check/,
    );
    await expect(attemptRawSettlement(world, { amount: 499 })).rejects.toThrow(
      /FinancialSwap_shape_check/,
    );
    const outsiderHolder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: '999999' },
    });
    await expect(
      attemptRawSettlement(world, { beneficiaryHolderId: outsiderHolder.id }),
    ).rejects.toThrow(/FinancialSwap_shape_check/);
    expect(await prisma.financialSwapAction.count()).toBe(0);
    expect(await prisma.financialLot.count({ where: { currency: 'INCOME' } })).toBe(0);
  });
});
