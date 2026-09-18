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
  planPointCharge,
  planPointChargeCommand,
  planPointChargeStart,
  identifyPointChargeFundingSources,
  type PointChargeInput,
  type PointChargeResult,
} from './point-charge.core.js';

/** Internal use-case. A verified-payment adapter must own any public entrypoint. */
export function createPointChargeService(db: Db) {
  async function charge(input: PointChargeInput): Promise<PointChargeResult> {
    const holderId = await financialLedgerRepo.findHolderId(db.rw, {
      namespace: 'user',
      key: String(input.actorId),
    });
    return uow.serialized(
      db,
      [
        lockKey.financialHolder(holderId),
        lockKey.pointChargePayment(input.externalPaymentId),
        lockKey.pointChargeCommand(`${input.actorId}:CHARGE:${input.commandKey}`),
      ],
      (tx) => executePointCharge(tx, input, holderId),
    );
  }

  async function traceCommissionFunding(reservationId: number) {
    const allocations = await financialLedgerRepo.loadCommissionPointFundingAllocations(
      db.rw,
      reservationId,
    );
    return identifyPointChargeFundingSources(allocations).map((source) => ({
      ...source,
      referenceId: formatTransactionReference({ kind: 'POINT_CHARGE', id: source.flowId }),
      operationReferenceId: formatOperationId({ kind: 'CHARGE', id: source.operationId }),
    }));
  }

  return { charge, traceCommissionFunding };
}

async function executePointCharge(
  tx: DbClient,
  input: PointChargeInput,
  lockedHolderId: number,
): Promise<PointChargeResult> {
  const payloadHash = hashPayload(input);
  const requested = { ...planPointChargeCommand(input), payloadHash };
  const command = await transactionFlowRepo.findCommand(tx, requested);
  const payment = command
    ? null
    : await transactionFlowRepo.findCompletedCommandBySubject(tx, requested);
  const start = planPointChargeStart(command, payment, requested);
  if (start.kind === 'REPLAY') return loadResult(tx, start.identity, true);

  // Ledger domain: bind one paid POINT lot to the user's AVAILABLE account.
  const world = await financialLedgerRepo.loadPointChargeWorld(tx, lockedHolderId);
  const plan = planPointCharge(world, input);
  const flow = await transactionFlowRepo.createFlow(tx, plan.flowRequest);
  const started = await transactionFlowRepo.startCommand(tx, {
    flowId: flow.id,
    ...plan.commandRequest,
    payloadHash,
  });
  const operation = await transactionFlowRepo.createOperation(tx, {
    commandId: started.id,
    flowId: flow.id,
    kind: plan.operationRequest.kind,
  });
  await financialLedgerRepo.applyPointChargeLot(tx, {
    flowId: flow.id,
    operationId: operation.id,
    request: plan.lotRequest,
  });
  await transactionFlowRepo.completeCommand(tx, {
    commandId: started.id,
    operationId: operation.id,
  });
  await transactionFlowRepo.assertCommandEffectCompleteness(tx);
  return loadResult(
    tx,
    {
      operationDbId: operation.id,
      referenceId: formatTransactionReference({ kind: flow.kind, id: flow.id }),
      commandId: formatCommandId({ kind: started.kind, id: started.id }),
      operationId: formatOperationId({ kind: operation.kind, id: operation.id }),
    },
    false,
  );
}

async function loadResult(
  tx: DbClient,
  identity: CompletedIdentity,
  replayed: boolean,
): Promise<PointChargeResult> {
  const stored = await financialLedgerRepo.loadPointChargeLedgerResult(
    tx,
    identity.operationDbId,
  );
  return {
    ...stored,
    referenceId: identity.referenceId,
    commandId: identity.commandId,
    operationId: identity.operationId,
    replayed,
  };
}

type CompletedIdentity = {
  operationDbId: string;
  referenceId: string;
  commandId: string;
  operationId: string;
};

function hashPayload(input: PointChargeInput) {
  return createHash('sha256')
    .update(JSON.stringify([input.actorId, input.amount, input.externalPaymentId]))
    .digest('hex');
}

export type PointChargeService = ReturnType<typeof createPointChargeService>;
