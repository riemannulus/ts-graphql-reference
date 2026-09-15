import { createHash } from 'node:crypto';
import type { Db, DbClient } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import * as contractRepo from '../contract/contract.repo.js';
import * as financialLedgerRepo from '../financial-ledger/financial-ledger.repo.js';
import * as orderRepo from '../order/order.repo.js';
import {
  formatCommandId,
  formatOperationId,
  formatTransactionReference,
} from '../transaction-flow/transaction-flow.core.js';
import * as transactionFlowRepo from '../transaction-flow/transaction-flow.repo.js';
import {
  COMMISSION_CONTRACT_NAMESPACE,
  assertCommissionSettlementHolderIdentity,
  assertCommissionSettlementReplayFlow,
  planCommissionSettlement,
  planCommissionSettlementStart,
  type CommissionSettlementInput,
  type CommissionSettlementResult,
} from './commission-settlement.core.js';

export function createCommissionSettlementService(db: Db) {
  async function settle(input: CommissionSettlementInput): Promise<CommissionSettlementResult> {
    const lockContract = await contractRepo.loadCommissionSettlementContract(
      db.rw,
      input.contractId,
    );
    const workerHolderId = await financialLedgerRepo.findHolderId(db.rw, {
      namespace: 'user',
      key: String(lockContract.workerId),
    });
    return uow.serialized(
      db,
      [
        lockKey.commissionContract(input.contractId),
        lockKey.financialHolder(workerHolderId),
        lockKey.commissionSettlementCommand(`${input.actorId}:SETTLE:${input.commandKey}`),
      ],
      (tx) => executeSettlement(tx, input, workerHolderId),
    );
  }
  return { settle };
}

async function executeSettlement(
  tx: DbClient,
  input: CommissionSettlementInput,
  lockedWorkerHolderId: number,
): Promise<CommissionSettlementResult> {
  const payloadHash = hashPayload(input);
  const requested = {
    flowKind: 'COMMISSION' as const,
    kind: 'SETTLE' as const,
    principalId: input.actorId,
    idempotencyKey: input.commandKey,
    payloadHash,
    subjectNamespace: COMMISSION_CONTRACT_NAMESPACE,
    subjectKey: String(input.contractId),
  };
  const existing = await transactionFlowRepo.findCommand(tx, requested);
  const completed = existing
    ? null
    : await transactionFlowRepo.findCompletedCommandBySubject(tx, requested);
  const start = planCommissionSettlementStart(existing, completed, requested);
  if (start.kind === 'REPLAY') {
    return loadResult(tx, start.identity, input.contractId, true);
  }
  if (start.kind === 'ALIAS') {
    const identity = start.identity;
    const stored = await loadResult(tx, identity, input.contractId, true);
    const alias = await transactionFlowRepo.saveCommandAlias(tx, {
      flowId: identity.flowId,
      ...requested,
      resultOperationId: identity.operationDbId,
    });
    await transactionFlowRepo.assertCommandEffectCompleteness(tx);
    return { ...stored, commandId: formatCommandId({ kind: alias.kind, id: alias.id }) };
  }

  // Product domain: read the formed Contract and its paid Order-owned reservation link.
  const contract = await contractRepo.loadCommissionSettlementContract(
    tx,
    input.contractId,
  );
  const commerce = await orderRepo.loadCommissionSettlementOrderSnapshot(
    tx,
    contract.orderId,
  );
  const workerHolderId = await financialLedgerRepo.findHolderId(tx, {
    namespace: 'user',
    key: String(contract.workerId),
  });
  assertCommissionSettlementHolderIdentity(lockedWorkerHolderId, workerHolderId);
  // Ledger domain: prove the paid POINT transfer and resolve both swap legs.
  const funding = await financialLedgerRepo.loadCommissionSettlementFunding(
    tx,
    commerce.payment.fundingLink.reservationId,
  );
  const accounts = await financialLedgerRepo.loadCommissionSettlementAccounts(
    tx,
    workerHolderId,
  );
  const plan = planCommissionSettlement(
    { contract, order: commerce.order, payment: commerce.payment, funding, accounts },
    input,
  );

  const command = await transactionFlowRepo.startCommand(tx, {
    ...plan.commandRequest,
    payloadHash,
  });
  const operation = await transactionFlowRepo.createOperation(tx, {
    commandId: command.id,
    flowId: command.flowId,
    kind: plan.operationRequest.kind,
  });
  // Ledger domain: persist the paired SWAP legs and the commission-sourced INCOME lot.
  const { lot } = await financialLedgerRepo.applyCommissionIncomeSettlement(tx, {
    ...plan.swap,
    operationId: operation.id,
  });
  await transactionFlowRepo.completeCommand(tx, {
    commandId: command.id,
    operationId: operation.id,
  });
  await financialLedgerRepo.assertCommissionSettlementShape(tx);
  return {
    contractId: input.contractId,
    reservationId: plan.swap.reservationId,
    incomeLotId: lot.id,
    referenceId: formatTransactionReference({ kind: command.flowKind, id: command.flowId }),
    commandId: formatCommandId({ kind: command.kind, id: command.id }),
    operationId: formatOperationId({ kind: operation.kind, id: operation.id }),
    replayed: false,
  };
}

async function loadResult(
  tx: DbClient,
  identity: CompletedIdentity,
  contractId: number,
  replayed: boolean,
): Promise<CommissionSettlementResult> {
  const contract = await contractRepo.loadCommissionSettlementContract(tx, contractId);
  assertCommissionSettlementReplayFlow(identity.flowId, contract.flowId);
  const ledgerResult = await financialLedgerRepo.loadCommissionSettlementLedgerResult(
    tx,
    identity.operationDbId,
  );
  return {
    contractId,
    reservationId: ledgerResult.reservationId,
    incomeLotId: ledgerResult.incomeLotId,
    referenceId: identity.referenceId,
    commandId: identity.commandId,
    operationId: identity.operationId,
    replayed,
  };
}

interface CompletedIdentity {
  flowId: string;
  operationDbId: string;
  referenceId: string;
  commandId: string;
  operationId: string;
}

function hashPayload(input: CommissionSettlementInput) {
  return createHash('sha256')
    .update(JSON.stringify([input.contractId, input.actorId]))
    .digest('hex');
}

export type CommissionSettlementService = ReturnType<typeof createCommissionSettlementService>;
