export type TransactionFlowKind = 'COMMISSION' | 'WITHDRAWAL' | 'POINT_CHARGE';
export type FinancialCommandKind =
  | 'PAY'
  | 'EXTRA_PAY'
  | 'SETTLE'
  | 'REFUND'
  | 'CANCEL'
  | 'WITHDRAW'
  | 'CHARGE';

export function formatTransactionReference(input: {
  kind: TransactionFlowKind;
  id: string;
}): string {
  return `${input.kind}-${input.id}`;
}

export function formatCommandId(input: { kind: FinancialCommandKind; id: string }): string {
  return `CMD-${input.kind}-${input.id}`;
}

export function formatOperationId(input: { kind: FinancialCommandKind; id: string }): string {
  return `OP-${input.kind}-${input.id}`;
}
