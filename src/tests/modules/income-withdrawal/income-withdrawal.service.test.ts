import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createIncomeWithdrawalService } from '../../../modules/income-withdrawal/income-withdrawal.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function seedIncomeLot(
  principalId: number,
  accountId: number,
  suffix: string,
  amount: number,
) {
  return prisma.$transaction(async (tx) => {
    const beneficiary = await tx.financialAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { holderId: true },
    });
    const buyer = await tx.user.create({ data: { email: `income-source-${suffix}@example.com` } });
    const platform = await tx.financialHolder.upsert({
      where: {
        bindingNamespace_bindingKey: { bindingNamespace: 'system', bindingKey: 'platform' },
      },
      create: { bindingNamespace: 'system', bindingKey: 'platform' },
      update: {},
    });
    const pointSettled = await tx.financialAccount.upsert({
      where: {
        holderId_currency_purpose: {
          holderId: platform.id,
          currency: 'POINT',
          purpose: 'SETTLED',
        },
      },
      create: { holderId: platform.id, currency: 'POINT', purpose: 'SETTLED' },
      update: {},
    });
    const incomeIssuer = await tx.financialAccount.upsert({
      where: {
        holderId_currency_purpose: {
          holderId: platform.id,
          currency: 'INCOME',
          purpose: 'ISSUER',
        },
      },
      create: { holderId: platform.id, currency: 'INCOME', purpose: 'ISSUER' },
      update: {},
    });
    const payerHolder = await tx.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
    });
    const payerAvailable = await tx.financialAccount.create({
      data: { holderId: payerHolder.id, currency: 'POINT', purpose: 'AVAILABLE' },
    });
    const pointLot = await tx.financialLot.create({
      data: {
        accountId: payerAvailable.id,
        sourceKind: 'PAID',
        originalAmount: amount,
        remainingAmount: amount,
      },
    });
    const flow = await tx.transactionFlow.create({
      data: {
        kind: 'COMMISSION',
        policies: {
          createMany: { data: [{ commandKind: 'PAY' }, { commandKind: 'SETTLE' }] },
        },
      },
    });
    const commissionType = await tx.commissionType.create({
      data: { workerId: principalId, title: suffix, price: amount },
    });
    const slot = await tx.commissionSlot.create({
      data: { workerId: principalId, state: 'OCCUPIED' },
    });
    const order = await tx.order.create({
      data: {
        flowId: flow.id,
        buyerId: buyer.id,
        commissionTypeId: commissionType.id,
        slotId: slot.id,
        titleSnapshot: suffix,
        amount,
        state: 'PAID',
      },
    });
    const payment = await tx.orderPayment.create({
      data: { orderId: order.id, flowId: flow.id, amount, state: 'PAID' },
    });
    const contract = await tx.contract.create({
      data: {
        orderId: order.id,
        flowId: flow.id,
        buyerId: buyer.id,
        workerId: principalId,
      },
    });
    const payCommand = await tx.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: buyer.id,
        idempotencyKey: `pay-${suffix}`,
        payloadHash: suffix,
        subjectNamespace: 'commission-order-payment',
        subjectKey: String(payment.id),
      },
    });
    const payOperation = await tx.financialOperation.create({
      data: { flowId: flow.id, kind: 'PAY', originatingCommandId: payCommand.id },
    });
    const payAction = await tx.financialTransferAction.create({
      data: { flowId: flow.id, operationId: payOperation.id, operationKind: 'PAY' },
    });
    const reservation = await tx.financialReservation.create({
      data: {
        flowId: flow.id,
        bindingNamespace: 'commission-order-payment',
        bindingKey: String(payment.id),
        holderId: payerHolder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: amount,
      },
    });
    await tx.orderFinancialLink.create({
      data: { orderPaymentId: payment.id, flowId: flow.id, reservationId: reservation.id },
    });
    const escrow = await tx.financialAccount.create({
      data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
    });
    await tx.financialLot.update({
      where: { id: pointLot.id },
      data: { remainingAmount: 0 },
    });
    const funding = await tx.financialTransfer.create({
      data: {
        reservationId: reservation.id,
        flowId: flow.id,
        currency: 'POINT',
        fromAccountId: payerAvailable.id,
        toAccountId: escrow.id,
        amount,
        actionId: payAction.id,
      },
    });
    await tx.financialTransferAllocation.create({
      data: {
        transferId: funding.id,
        fromAccountId: payerAvailable.id,
        currency: 'POINT',
        lotId: pointLot.id,
        amount,
      },
    });
    await tx.financialCommandRun.update({
      where: { id: payCommand.id },
      data: { resultOperationId: payOperation.id },
    });
    const settleCommand = await tx.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'COMMISSION',
        kind: 'SETTLE',
        principalId,
        idempotencyKey: `settle-${suffix}`,
        payloadHash: suffix,
        subjectNamespace: 'commission-contract',
        subjectKey: String(contract.id),
      },
    });
    const operation = await tx.financialOperation.create({
      data: { flowId: flow.id, kind: 'SETTLE', originatingCommandId: settleCommand.id },
    });
    const swap = await tx.financialSwapAction.create({
      data: {
        flowId: flow.id,
        operationId: operation.id,
        operationKind: 'SETTLE',
        reservationId: reservation.id,
        beneficiaryHolderId: beneficiary.holderId!,
      },
    });
    await tx.financialSwapLeg.createMany({
      data: [
        {
          actionId: swap.id,
          flowId: flow.id,
          currency: 'POINT',
          fromAccountId: escrow.id,
          toAccountId: pointSettled.id,
          amount,
        },
        {
          actionId: swap.id,
          flowId: flow.id,
          currency: 'INCOME',
          fromAccountId: incomeIssuer.id,
          toAccountId: accountId,
          amount,
        },
      ],
    });
    const lot = await tx.financialLot.create({
      data: {
        accountId,
        currency: 'INCOME',
        sourceKind: 'COMMISSION_SETTLEMENT',
        sourceOperationId: operation.id,
        sourceSwapActionId: swap.id,
        sourceFlowId: flow.id,
        sourceFlowKind: 'COMMISSION',
        sourceOperationKind: 'SETTLE',
        originalAmount: amount,
        remainingAmount: amount,
      },
    });
    await tx.financialReservation.update({
      where: { id: reservation.id },
      data: { state: 'SETTLED' },
    });
    await tx.financialCommandRun.update({
      where: { id: settleCommand.id },
      data: { resultOperationId: operation.id },
    });
    await tx.$executeRawUnsafe(
      'SET CONSTRAINTS "FinancialSwap_shape_check", "FinancialReservation_settlement_shape_check" IMMEDIATE',
    );
    return { flow, lot };
  });
}

async function attemptRawWithdrawalEffect(
  input: {
    workerId: number;
    holderId: number;
    availableAccountId: number;
    lotId: number;
    commandKind: 'PAY' | 'WITHDRAW';
    includeWithdrawal: boolean;
    completeCommand: boolean;
  },
) {
  return prisma.$transaction(async (tx) => {
    const flow = await tx.transactionFlow.create({
      data: {
        kind: 'WITHDRAWAL',
        policies: { create: { commandKind: input.commandKind } },
      },
    });
    const command = await tx.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'WITHDRAWAL',
        kind: input.commandKind,
        principalId: input.workerId,
        idempotencyKey: `raw-${input.commandKind}-${input.includeWithdrawal}-${input.completeCommand}`,
        payloadHash: 'raw-withdrawal-effect',
        subjectNamespace: 'income-withdrawal',
        subjectKey: flow.id,
      },
    });
    const operation = await tx.financialOperation.create({
      data: { flowId: flow.id, kind: input.commandKind, originatingCommandId: command.id },
    });
    const action = await tx.financialTransferAction.create({
      data: { flowId: flow.id, operationId: operation.id, operationKind: input.commandKind },
    });
    const reservation = await tx.financialReservation.create({
      data: {
        flowId: flow.id,
        bindingNamespace: 'income-withdrawal',
        bindingKey: flow.id,
        holderId: input.holderId,
        purpose: 'INCOME_WITHDRAWAL',
        currency: 'INCOME',
        targetAmount: 10,
      },
    });
    const escrow = await tx.financialAccount.create({
      data: { reservationId: reservation.id, currency: 'INCOME', purpose: 'ESCROW' },
    });
    await tx.financialLot.update({
      where: { id: input.lotId },
      data: { remainingAmount: 90 },
    });
    const transfer = await tx.financialTransfer.create({
      data: {
        reservationId: reservation.id,
        flowId: flow.id,
        currency: 'INCOME',
        fromAccountId: input.availableAccountId,
        toAccountId: escrow.id,
        amount: 10,
        actionId: action.id,
      },
    });
    await tx.financialTransferAllocation.create({
      data: {
        transferId: transfer.id,
        fromAccountId: input.availableAccountId,
        currency: 'INCOME',
        lotId: input.lotId,
        amount: 10,
      },
    });
    if (input.includeWithdrawal) {
      await tx.financialWithdrawal.create({
        data: {
          flowId: flow.id,
          flowKind: 'WITHDRAWAL',
          operationId: operation.id,
          operationKind: 'WITHDRAW',
          transferActionId: action.id,
          reservationId: reservation.id,
        },
      });
    }
    if (input.completeCommand) {
      await tx.financialCommandRun.update({
        where: { id: command.id },
        data: { resultOperationId: operation.id },
      });
    }
    await tx.$executeRawUnsafe(
      'SET CONSTRAINTS "FinancialWithdrawal_shape_check", "FinancialWithdrawal_totality_check", "FinancialCommand_effect_completeness_check", "FinancialTransfer_command_completion_check" IMMEDIATE',
    );
  });
}

describe('IncomeWithdrawalService.request', () => {
  it('holds FIFO INCOME from multiple commissions and exposes amount-level lineage', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-worker@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    const first = await seedIncomeLot(worker.id, available.id, 'first', 30);
    const second = await seedIncomeLot(worker.id, available.id, 'second', 50);
    const service = createIncomeWithdrawalService(db);

    const result = await service.request({ actorId: worker.id, amount: 60, commandKey: 'w-1' });

    expect(result).toEqual({
      withdrawalId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      reservationId: expect.any(Number),
      referenceId: expect.stringMatching(/^WITHDRAWAL-[0-9a-f-]{36}$/),
      commandId: expect.stringMatching(/^CMD-WITHDRAW-[0-9a-f-]{36}$/),
      operationId: expect.stringMatching(/^OP-WITHDRAW-[0-9a-f-]{36}$/),
      replayed: false,
      sources: [
        { commissionReferenceId: `COMMISSION-${first.flow.id}`, amount: 30 },
        { commissionReferenceId: `COMMISSION-${second.flow.id}`, amount: 30 },
      ],
    });
    expect(
      await prisma.financialLot.findMany({
        where: { currency: 'INCOME' },
        orderBy: { id: 'asc' },
        select: { remainingAmount: true },
      }),
    ).toEqual([{ remainingAmount: 0 }, { remainingAmount: 20 }]);
    const withdrawal = await prisma.financialWithdrawal.findUniqueOrThrow({
      where: { id: result.withdrawalId },
      include: { reservation: { include: { escrowAccount: true, transfer: true } } },
    });
    expect(withdrawal.reservation).toMatchObject({
      holderId: holder.id,
      targetAmount: 60,
      currency: 'INCOME',
      state: 'HELD',
    });
    expect(withdrawal.reservation.escrowAccount).toMatchObject({
      currency: 'INCOME',
      purpose: 'ESCROW',
    });
    await expect(
      prisma.financialTransferAction.create({
        data: {
          flowId: withdrawal.flowId,
          operationId: withdrawal.operationId,
          operationKind: 'WITHDRAW',
        },
      }),
    ).rejects.toThrow(/operationId/);
    await expect(
      prisma.financialWithdrawal.delete({ where: { id: withdrawal.id } }),
    ).rejects.toThrow(/FinancialWithdrawal_append_only/);

    const replay = await service.request({ actorId: worker.id, amount: 60, commandKey: 'w-1' });
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await prisma.financialWithdrawal.count()).toBe(1);
  });

  it('rejects insufficient INCOME before creating a WITHDRAWAL flow', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-insufficient@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    await seedIncomeLot(worker.id, available.id, 'only', 20);

    await expect(
      createIncomeWithdrawalService(db).request({
        actorId: worker.id,
        amount: 21,
        commandKey: 'too-large',
      }),
    ).rejects.toThrow(/Insufficient INCOME/);
    expect(await prisma.transactionFlow.count({ where: { kind: 'WITHDRAWAL' } })).toBe(0);
    expect(await prisma.financialWithdrawal.count()).toBe(0);
    expect(
      await prisma.financialLot.findFirstOrThrow({ where: { currency: 'INCOME' } }),
    ).toMatchObject({ remainingAmount: 20 });
  });

  it('rejects reuse of a withdrawal command key with a different amount', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-key@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    await seedIncomeLot(worker.id, available.id, 'key', 100);
    const service = createIncomeWithdrawalService(db);
    await service.request({ actorId: worker.id, amount: 40, commandKey: 'same-key' });

    await expect(
      service.request({ actorId: worker.id, amount: 41, commandKey: 'same-key' }),
    ).rejects.toThrow(/identity mismatch/);
    expect(await prisma.financialWithdrawal.count()).toBe(1);
    expect(
      await prisma.financialLot.findFirstOrThrow({ where: { currency: 'INCOME' } }),
    ).toMatchObject({ remainingAmount: 60 });
  });

  it('rejects a complete raw withdrawal whose command subject is not its flow', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-subject@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    const source = await seedIncomeLot(worker.id, available.id, 'wrong-subject', 100);

    await expect(
      prisma.$transaction(async (tx) => {
        const flow = await tx.transactionFlow.create({
          data: { kind: 'WITHDRAWAL', policies: { create: { commandKind: 'WITHDRAW' } } },
        });
        const command = await tx.financialCommandRun.create({
          data: {
            flowId: flow.id,
            flowKind: 'WITHDRAWAL',
            kind: 'WITHDRAW',
            principalId: worker.id,
            idempotencyKey: 'wrong-subject',
            payloadHash: 'wrong-subject',
            subjectNamespace: 'wrong-namespace',
            subjectKey: 'wrong-key',
          },
        });
        const operation = await tx.financialOperation.create({
          data: { flowId: flow.id, kind: 'WITHDRAW', originatingCommandId: command.id },
        });
        const action = await tx.financialTransferAction.create({
          data: { flowId: flow.id, operationId: operation.id, operationKind: 'WITHDRAW' },
        });
        const reservation = await tx.financialReservation.create({
          data: {
            flowId: flow.id,
            bindingNamespace: 'income-withdrawal',
            bindingKey: flow.id,
            holderId: holder.id,
            purpose: 'INCOME_WITHDRAWAL',
            currency: 'INCOME',
            targetAmount: 10,
          },
        });
        const escrow = await tx.financialAccount.create({
          data: { reservationId: reservation.id, currency: 'INCOME', purpose: 'ESCROW' },
        });
        await tx.financialLot.update({
          where: { id: source.lot.id },
          data: { remainingAmount: 90 },
        });
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: reservation.id,
            flowId: flow.id,
            currency: 'INCOME',
            fromAccountId: available.id,
            toAccountId: escrow.id,
            amount: 10,
            actionId: action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: {
            transferId: transfer.id,
            fromAccountId: available.id,
            currency: 'INCOME',
            lotId: source.lot.id,
            amount: 10,
          },
        });
        await tx.financialWithdrawal.create({
          data: {
            flowId: flow.id,
            flowKind: 'WITHDRAWAL',
            operationId: operation.id,
            operationKind: 'WITHDRAW',
            transferActionId: action.id,
            reservationId: reservation.id,
          },
        });
        await tx.financialCommandRun.update({
          where: { id: command.id },
          data: { resultOperationId: operation.id },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS "FinancialWithdrawal_shape_check" IMMEDIATE');
      }),
    ).rejects.toThrow(/FinancialWithdrawal_shape_check/);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: source.lot.id } }))
      .toMatchObject({ remainingAmount: 100 });
  });

  it('rejects a WITHDRAWAL effect disguised as a PAY transfer', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-pay-bypass@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    const source = await seedIncomeLot(worker.id, available.id, 'pay-bypass', 100);

    await expect(
      attemptRawWithdrawalEffect({
        workerId: worker.id,
        holderId: holder.id,
        availableAccountId: available.id,
        lotId: source.lot.id,
        commandKind: 'PAY',
        includeWithdrawal: false,
        completeCommand: true,
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: source.lot.id } }))
      .toMatchObject({ remainingAmount: 100 });
  });

  it('rejects a complete WITHDRAW effect without its withdrawal aggregate', async () => {
    const worker = await prisma.user.create({ data: { email: 'withdraw-totality@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
    });
    const available = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    const source = await seedIncomeLot(worker.id, available.id, 'missing-aggregate', 100);

    await expect(
      attemptRawWithdrawalEffect({
        workerId: worker.id,
        holderId: holder.id,
        availableAccountId: available.id,
        lotId: source.lot.id,
        commandKind: 'WITHDRAW',
        includeWithdrawal: false,
        completeCommand: true,
      }),
    ).rejects.toThrow(/FinancialWithdrawal_totality_check/);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: source.lot.id } }))
      .toMatchObject({ remainingAmount: 100 });
  });
});
