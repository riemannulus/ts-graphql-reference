import { createHash } from 'node:crypto';
import type { Db, DbClient } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import * as financialLedgerRepo from '../financial-ledger/financial-ledger.repo.js';
import {
  formatCommandId,
  formatOperationId,
  formatTransactionReference,
} from '../transaction-flow/transaction-flow.core.js';
import * as transactionFlowRepo from '../transaction-flow/transaction-flow.repo.js';
import {
  assertIncomeWithdrawalReplay,
  planIncomeWithdrawal,
  type IncomeWithdrawalInput,
  type IncomeWithdrawalResult,
} from './income-withdrawal.core.js';
import * as incomeWithdrawalRepo from './income-withdrawal.repo.js';

export function createIncomeWithdrawalService(db: Db) {
  async function request(input: IncomeWithdrawalInput): Promise<IncomeWithdrawalResult> {
    const holderId = await financialLedgerRepo.findHolderId(db.rw, {
      namespace: 'user',
      key: String(input.actorId),
    });
    return uow.serialized(
      db,
      [
        lockKey.financialHolder(holderId),
        lockKey.incomeWithdrawalCommand(`${input.actorId}:WITHDRAW:${input.commandKey}`),
      ],
      (tx) => executeWithdrawal(tx, input, holderId),
    );
  }
  return { request };
}

async function executeWithdrawal(
  tx: DbClient,
  input: IncomeWithdrawalInput,
  lockedHolderId: number,
): Promise<IncomeWithdrawalResult> {
  const payloadHash = hashPayload(input);
  const lookup = {
    principalId: input.actorId,
    kind: 'WITHDRAW' as const,
    idempotencyKey: input.commandKey,
  };
  const existing = await transactionFlowRepo.findCommand(tx, lookup);
  if (existing) {
    return loadResult(tx, assertIncomeWithdrawalReplay(existing, payloadHash), true);
  }

  // Ledger domain: plan FIFO consumption from the worker's withdrawable INCOME lots.
  const world = await financialLedgerRepo.loadAvailableIncomeWorld(tx, lockedHolderId);
  const plan = planIncomeWithdrawal(world, input);
  const flow = await transactionFlowRepo.createFlow(tx, plan.flowRequest);
  const command = await transactionFlowRepo.startCommand(tx, {
    flowId: flow.id,
    ...plan.commandRequest,
    payloadHash,
    subjectKey: flow.id,
  });
  const operation = await transactionFlowRepo.createOperation(tx, {
    commandId: command.id,
    flowId: flow.id,
    kind: plan.operationRequest.kind,
  });
  const action = await financialLedgerRepo.createTransferAction(tx, {
    operationId: operation.id,
    flowId: flow.id,
    operationKind: plan.operationRequest.kind,
  });
  const reservation = await financialLedgerRepo.applyIncomeWithdrawalReservation(tx, {
    flowId: flow.id,
    request: { ...plan.reservationRequest, bindingKey: flow.id },
    actionId: action.id,
  });
  await incomeWithdrawalRepo.createWithdrawal(tx, {
    flowId: flow.id,
    flowKind: plan.withdrawalRequest.flowKind,
    operationId: operation.id,
    operationKind: plan.operationRequest.kind,
    transferActionId: action.id,
    reservationId: reservation.id,
  });
  await transactionFlowRepo.completeCommand(tx, {
    commandId: command.id,
    operationId: operation.id,
  });
  await incomeWithdrawalRepo.assertWithdrawalShape(tx);
  return loadResult(
    tx,
    {
      flowId: flow.id,
      operationDbId: operation.id,
      referenceId: formatTransactionReference({ kind: flow.kind, id: flow.id }),
      commandId: formatCommandId({ kind: command.kind, id: command.id }),
      operationId: formatOperationId({ kind: operation.kind, id: operation.id }),
    },
    false,
  );
}

async function loadResult(
  tx: DbClient,
  identity: CompletedIdentity,
  replayed: boolean,
): Promise<IncomeWithdrawalResult> {
  const stored = await incomeWithdrawalRepo.loadWithdrawalResult(tx, identity.flowId);
  const sources = await financialLedgerRepo.loadIncomeWithdrawalSources(
    tx,
    stored.reservationId,
  );
  return {
    withdrawalId: stored.withdrawalId,
    reservationId: stored.reservationId,
    referenceId: identity.referenceId,
    commandId: identity.commandId,
    operationId: identity.operationId,
    replayed,
    sources: sources.map(({ flowId, flowKind, amount }) => ({
      commissionReferenceId: formatTransactionReference({ kind: flowKind, id: flowId }),
      amount,
    })),
  };
}

type CompletedIdentity = {
  flowId: string;
  operationDbId: string;
  referenceId: string;
  commandId: string;
  operationId: string;
};

function hashPayload(input: IncomeWithdrawalInput) {
  return createHash('sha256')
    .update(JSON.stringify([input.actorId, input.amount]))
    .digest('hex');
}

export type IncomeWithdrawalService = ReturnType<typeof createIncomeWithdrawalService>;
