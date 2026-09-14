import type { DbClient } from '../../db/db.js';
import {
  formatCommandId,
  formatOperationId,
  formatTransactionReference,
  type FinancialCommandKind,
  type TransactionFlowKind,
} from './transaction-flow.core.js';

export interface FinancialCommandRequest {
  flowId: string;
  flowKind: TransactionFlowKind;
  kind: FinancialCommandKind;
  principalId: number;
  idempotencyKey: string;
  payloadHash: string;
  subjectNamespace: string;
  subjectKey: string;
}

const commandResultSelect = {
  id: true,
  flowId: true,
  flowKind: true,
  kind: true,
  payloadHash: true,
  subjectNamespace: true,
  subjectKey: true,
  resultOperation: { select: { id: true, kind: true } },
} as const;

function mapStoredCommand(row: {
  id: string;
  flowId: string;
  flowKind: TransactionFlowKind;
  kind: FinancialCommandKind;
  payloadHash: string;
  subjectNamespace: string;
  subjectKey: string;
  resultOperation: { id: string; kind: FinancialCommandKind } | null;
}) {
  return {
    commandDbId: row.id,
    flowId: row.flowId,
    flowKind: row.flowKind,
    kind: row.kind,
    payloadHash: row.payloadHash,
    subjectNamespace: row.subjectNamespace,
    subjectKey: row.subjectKey,
    operationDbId: row.resultOperation?.id ?? null,
    referenceId: formatTransactionReference({ kind: row.flowKind, id: row.flowId }),
    commandId: formatCommandId({ kind: row.kind, id: row.id }),
    operationId: row.resultOperation
      ? formatOperationId({ kind: row.resultOperation.kind, id: row.resultOperation.id })
      : null,
  };
}

export async function findCommand(
  db: DbClient,
  input: Pick<FinancialCommandRequest, 'principalId' | 'kind' | 'idempotencyKey'>,
) {
  const row = await db.financialCommandRun.findUnique({
    where: {
      principalId_kind_idempotencyKey: {
        principalId: input.principalId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: commandResultSelect,
  });
  return row ? mapStoredCommand(row) : null;
}

export async function findCompletedCommandBySubject(
  db: DbClient,
  input: Pick<FinancialCommandRequest, 'flowKind' | 'subjectNamespace' | 'subjectKey' | 'kind'>,
) {
  const row = await db.financialCommandRun.findFirst({
    where: {
      subjectNamespace: input.subjectNamespace,
      subjectKey: input.subjectKey,
      flowKind: input.flowKind,
      kind: input.kind,
      resultOperationId: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: commandResultSelect,
  });
  return row ? mapStoredCommand(row) : null;
}

export function startCommand(db: DbClient, input: FinancialCommandRequest) {
  return db.financialCommandRun.create({
    data: input,
    select: { id: true, flowId: true, flowKind: true, kind: true },
  });
}

export async function createTransferOperation(
  db: DbClient,
  input: Pick<FinancialCommandRequest, 'flowId' | 'kind'> & {
    commandId: string;
    actionKind: 'TRANSFER';
  },
) {
  const operation = await db.financialOperation.create({
    data: { flowId: input.flowId, kind: input.kind, originatingCommandId: input.commandId },
    select: { id: true, flowId: true, kind: true },
  });
  const action = await db.financialTransferAction.create({
    data: { operationId: operation.id, flowId: operation.flowId },
    select: { id: true, flowId: true },
  });
  await db.financialCommandRun.update({
    where: { id: input.commandId },
    data: { resultOperationId: operation.id },
  });
  return { operation, action };
}

export function saveCommandAlias(
  db: DbClient,
  input: FinancialCommandRequest & { resultOperationId: string },
) {
  return db.financialCommandRun.create({
    data: input,
    select: { id: true, flowId: true, flowKind: true, kind: true },
  });
}
