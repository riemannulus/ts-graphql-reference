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

export function createFlow(
  db: DbClient,
  input: { kind: TransactionFlowKind; allowedCommands: readonly FinancialCommandKind[] },
) {
  return db.transactionFlow.create({
    data: {
      kind: input.kind,
      policies: { createMany: { data: input.allowedCommands.map((commandKind) => ({ commandKind })) } },
    },
    select: { id: true, kind: true },
  });
}

export function createOperation(
  db: DbClient,
  input: Pick<FinancialCommandRequest, 'flowId' | 'kind'> & {
    commandId: string;
  },
) {
  return db.financialOperation.create({
    data: { flowId: input.flowId, kind: input.kind, originatingCommandId: input.commandId },
    select: { id: true, flowId: true, kind: true },
  });
}

export function completeCommand(
  db: DbClient,
  input: { commandId: string; operationId: string },
) {
  return db.financialCommandRun.update({
    where: { id: input.commandId },
    data: { resultOperationId: input.operationId },
  });
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

export async function assertCommandEffectCompleteness(db: DbClient) {
  await db.$executeRawUnsafe(
    'SET CONSTRAINTS "FinancialCommand_effect_completeness_check", "FinancialTransfer_command_completion_check" IMMEDIATE',
  );
}
