import { DomainError } from '../../foundation/errors.js';

export const INCOME_WITHDRAWAL_NAMESPACE = 'income-withdrawal';

export interface IncomeWithdrawalInput {
  actorId: number;
  amount: number;
  commandKey: string;
}

export interface IncomeWithdrawalWorld {
  holderId: number;
  availableAccountId: number;
  lots: readonly { lotId: number; remainingAmount: number }[];
}

export class IncomeWithdrawalAmountError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_INCOME_WITHDRAWAL');
  }
}

interface WithdrawalReplayIdentity {
  flowId: string;
  flowKind: string;
  kind: string;
  payloadHash: string;
  subjectNamespace: string;
  subjectKey: string;
  operationDbId: string | null;
  referenceId: string;
  commandId: string;
  operationId: string | null;
}

export function assertIncomeWithdrawalReplay<T extends WithdrawalReplayIdentity>(
  stored: T,
  requestedPayloadHash: string,
): T & { operationDbId: string; operationId: string } {
  if (
    stored.flowKind !== 'WITHDRAWAL' ||
    stored.kind !== 'WITHDRAW' ||
    stored.payloadHash !== requestedPayloadHash ||
    stored.subjectNamespace !== INCOME_WITHDRAWAL_NAMESPACE ||
    stored.subjectKey !== stored.flowId
  ) {
    throw new IncomeWithdrawalAmountError('Withdrawal command key identity mismatch');
  }
  if (!stored.operationDbId || !stored.operationId) {
    throw new IncomeWithdrawalAmountError('Withdrawal command has no completed operation');
  }
  return stored as T & { operationDbId: string; operationId: string };
}

export function planIncomeWithdrawal(
  world: IncomeWithdrawalWorld,
  input: IncomeWithdrawalInput,
) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new IncomeWithdrawalAmountError('Withdrawal amount must be a positive integer');
  }

  let remaining = input.amount;
  const allocations: Array<{
    lotId: number;
    assumedRemainingAmount: number;
    amount: number;
  }> = [];
  for (const lot of world.lots) {
    if (remaining === 0) break;
    const amount = Math.min(lot.remainingAmount, remaining);
    if (amount > 0) {
      allocations.push({
        lotId: lot.lotId,
        assumedRemainingAmount: lot.remainingAmount,
        amount,
      });
      remaining -= amount;
    }
  }
  if (remaining > 0) {
    const available = input.amount - remaining;
    throw new IncomeWithdrawalAmountError(
      `Insufficient INCOME: have ${available}, need ${input.amount}`,
    );
  }

  return {
    flowRequest: { kind: 'WITHDRAWAL' as const, allowedCommands: ['WITHDRAW'] as const },
    commandRequest: {
      flowKind: 'WITHDRAWAL' as const,
      kind: 'WITHDRAW' as const,
      principalId: input.actorId,
      idempotencyKey: input.commandKey,
      subjectNamespace: INCOME_WITHDRAWAL_NAMESPACE,
      subjectKey: { source: 'FLOW_ID' as const },
    },
    operationRequest: { kind: 'WITHDRAW' as const, actionKind: 'TRANSFER' as const },
    reservationRequest: {
      bindingNamespace: INCOME_WITHDRAWAL_NAMESPACE,
      bindingKey: { source: 'FLOW_ID' as const },
      holderId: world.holderId,
      purpose: 'INCOME_WITHDRAWAL' as const,
      currency: 'INCOME' as const,
      amount: input.amount,
      escrowAccount: { purpose: 'ESCROW' as const, currency: 'INCOME' as const },
      transfer: {
        currency: 'INCOME' as const,
        amount: input.amount,
        fromAccountId: world.availableAccountId,
        allocations,
      },
    },
    withdrawalRequest: { flowKind: 'WITHDRAWAL' as const },
  };
}

export type IncomeWithdrawalPlan = ReturnType<typeof planIncomeWithdrawal>;

export interface IncomeWithdrawalResult {
  withdrawalId: string;
  reservationId: number;
  referenceId: string;
  commandId: string;
  operationId: string;
  replayed: boolean;
  sources: Array<{ commissionReferenceId: string; amount: number }>;
}
