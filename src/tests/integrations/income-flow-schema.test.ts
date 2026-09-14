import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

const prisma = await makeTestPrisma();

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('income settlement and withdrawal schema', () => {
  it('accepts a WITHDRAWAL flow whose only allowed command is WITHDRAW', async () => {
    const flowId = '01995c47-d1cb-7f11-a2bd-a954bbd828ec';
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "TransactionFlow" ("id", "kind") VALUES ($1::uuid, 'WITHDRAWAL')`,
          flowId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "FlowCommandPolicy" ("flowId", "commandKind") VALUES ($1::uuid, 'WITHDRAW')`,
          flowId,
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a SETTLE swap that does not contain one POINT and one INCOME leg', async () => {
    const principal = await prisma.user.create({ data: { email: 'swap-shape@example.com' } });
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'SETTLE' } } },
    });
    const command = await prisma.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'COMMISSION',
        kind: 'SETTLE',
        principalId: principal.id,
        idempotencyKey: 'malformed-swap',
        payloadHash: 'payload',
        subjectNamespace: 'commission-contract',
        subjectKey: '1',
      },
    });
    const operation = await prisma.financialOperation.create({
      data: { flowId: flow.id, kind: 'SETTLE', originatingCommandId: command.id },
    });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: 'swap-shape' },
    });
    const reservation = await prisma.financialReservation.create({
      data: {
        flowId: flow.id,
        bindingNamespace: 'commission-order-payment',
        bindingKey: 'swap-shape',
        holderId: holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "FinancialSwapAction" ("id", "flowId", "operationId", "operationKind", "reservationId", "beneficiaryHolderId") VALUES ($1::uuid, $2::uuid, $3::uuid, 'SETTLE', $4, $5)`,
          '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
          flow.id,
          operation.id,
          reservation.id,
          holder.id,
        );
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }),
    ).rejects.toThrow(/FinancialSwap_shape_check/);
  });

  it('rejects counterfeit INCOME provenance and a TRANSFER action on SETTLE', async () => {
    const principal = await prisma.user.create({ data: { email: 'counterfeit@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(principal.id) },
    });
    const income = await prisma.financialAccount.create({
      data: { holderId: holder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
    });
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'WITHDRAWAL', policies: { create: { commandKind: 'SETTLE' } } },
    });
    const command = await prisma.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'WITHDRAWAL',
        kind: 'SETTLE',
        principalId: principal.id,
        idempotencyKey: 'counterfeit',
        payloadHash: 'counterfeit',
        subjectNamespace: 'counterfeit',
        subjectKey: flow.id,
      },
    });
    const operation = await prisma.financialOperation.create({
      data: { flowId: flow.id, kind: 'SETTLE', originatingCommandId: command.id },
    });

    await expect(
      prisma.financialLot.create({
        data: {
          accountId: income.id,
          currency: 'INCOME',
          sourceKind: 'COMMISSION_SETTLEMENT',
          sourceOperationId: operation.id,
          sourceSwapActionId: '01995c47-d1cb-7f11-a2bd-a954bbd828ef',
          sourceFlowId: flow.id,
          sourceFlowKind: 'WITHDRAWAL',
          sourceOperationKind: 'SETTLE',
          originalAmount: 1,
          remainingAmount: 1,
        },
      }),
    ).rejects.toThrow(/FinancialLot_source_check/);
    await expect(
      prisma.financialTransferAction.create({
        data: {
          flowId: flow.id,
          operationId: operation.id,
          operationKind: 'SETTLE',
        },
      }),
    ).rejects.toThrow(/FinancialTransferAction_operation_kind_check/);
  });

  it('requires every reservation to start HELD', async () => {
    const flow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'state-test', bindingKey: 'settled' },
    });
    await expect(
      prisma.financialReservation.create({
        data: {
          flowId: flow.id,
          bindingNamespace: 'commission-order-payment',
          bindingKey: 'already-settled',
          holderId: holder.id,
          purpose: 'COMMISSION_PAYMENT',
          currency: 'POINT',
          targetAmount: 1,
          state: 'SETTLED',
        },
      }),
    ).rejects.toThrow(/FinancialReservation_initial_state/);
  });

  it('rejects a withdrawal record without its exact INCOME transfer', async () => {
    const principal = await prisma.user.create({ data: { email: 'withdraw-shape@example.com' } });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'withdraw-shape', bindingKey: 'holder' },
    });
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'WITHDRAWAL', policies: { create: { commandKind: 'WITHDRAW' } } },
    });
    const command = await prisma.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'WITHDRAWAL',
        kind: 'WITHDRAW',
        principalId: principal.id,
        idempotencyKey: 'withdraw-shape',
        payloadHash: 'withdraw-shape',
        subjectNamespace: 'income-withdrawal',
        subjectKey: flow.id,
      },
    });
    const operation = await prisma.financialOperation.create({
      data: { flowId: flow.id, kind: 'WITHDRAW', originatingCommandId: command.id },
    });
    const action = await prisma.financialTransferAction.create({
      data: { flowId: flow.id, operationId: operation.id, operationKind: 'WITHDRAW' },
    });
    const reservation = await prisma.financialReservation.create({
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

    await expect(
      prisma.$transaction(async (tx) => {
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
  });
});
