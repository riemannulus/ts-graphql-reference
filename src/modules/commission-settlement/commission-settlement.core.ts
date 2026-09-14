import { DomainError } from '../../foundation/errors.js';

export const COMMISSION_CONTRACT_NAMESPACE = 'commission-contract';

export interface CommissionSettlementInput {
  contractId: number;
  actorId: number;
  commandKey: string;
}

export interface CommissionSettlementFacts {
  contractId: number;
  contractOrderId: number;
  orderId: number;
  orderBuyerId: number;
  orderFlowId: string;
  flowId: string;
  workerId: number;
  orderState: string;
  orderAmount: number;
  orderCurrency: string;
  orderPaymentId: number;
  paymentState: string;
  paymentAmount: number;
  paymentCurrency: string;
  linkedReservationId: number;
  linkedReservationFlowId: string;
  reservationId: number;
  reservationFlowId: string;
  reservationState: string;
  reservationCurrency: string;
  reservationTargetAmount: number;
  reservationHolderBindingNamespace: string;
  reservationHolderBindingKey: string;
  pointEscrowAccountId: number;
  fundingTransferId: number;
  fundingTransferFlowId: string;
  fundingTransferCurrency: string;
  fundingTransferAmount: number;
  fundingTransferToAccountId: number;
  fundingActionOperationKind: string;
  fundingOperationId: string;
  fundingOperationFlowId: string;
  fundingOperationKind: string;
  fundingCommandFlowId: string;
  fundingCommandKind: string;
  fundingCommandPrincipalId: number;
  fundingCommandSubjectNamespace: string;
  fundingCommandSubjectKey: string;
  fundingCommandResultOperationId: string | null;
  pointSettledAccountId: number;
  incomeIssuerAccountId: number;
  incomeAvailableAccountId: number;
  beneficiaryHolderId: number;
}

export class CommissionSettlementStateError extends DomainError {
  constructor(message: string) {
    super(message, 'COMMISSION_NOT_SETTLEABLE');
  }
}

export function planCommissionSettlement(
  facts: CommissionSettlementFacts,
  input: CommissionSettlementInput,
) {
  if (facts.contractId !== input.contractId) {
    throw new CommissionSettlementStateError('Contract identity changed');
  }
  if (facts.contractOrderId !== facts.orderId) {
    throw new CommissionSettlementStateError('Contract Order identity changed');
  }
  if (facts.workerId !== input.actorId) {
    throw new CommissionSettlementStateError('Only the contract worker can settle commission');
  }
  if (facts.orderState !== 'PAID') {
    throw new CommissionSettlementStateError('Commission Order must be paid before settlement');
  }
  if (facts.paymentState !== 'PAID') {
    throw new CommissionSettlementStateError('Commission payment must be paid before settlement');
  }
  if (facts.reservationState !== 'HELD') {
    throw new CommissionSettlementStateError('Commission POINT must still be held for settlement');
  }
  if (
    facts.orderCurrency !== 'POINT' ||
    facts.paymentCurrency !== 'POINT' ||
    facts.reservationCurrency !== 'POINT' ||
    facts.fundingTransferCurrency !== 'POINT' ||
    facts.reservationTargetAmount <= 0
  ) {
    throw new CommissionSettlementStateError('Settlement input must be positive POINT');
  }
  if (
    facts.flowId !== facts.orderFlowId ||
    facts.flowId !== facts.linkedReservationFlowId ||
    facts.flowId !== facts.reservationFlowId ||
    facts.flowId !== facts.fundingTransferFlowId
  ) {
    throw new CommissionSettlementStateError('Settlement funding must belong to the Contract flow');
  }
  if (facts.linkedReservationId !== facts.reservationId) {
    throw new CommissionSettlementStateError('Settlement must use the Order-owned reservation link');
  }
  if (
    facts.fundingActionOperationKind !== 'PAY' ||
    facts.fundingOperationKind !== 'PAY' ||
    facts.fundingCommandKind !== 'PAY' ||
    facts.fundingOperationId !== facts.fundingCommandResultOperationId ||
    facts.fundingOperationFlowId !== facts.flowId ||
    facts.fundingCommandFlowId !== facts.flowId
  ) {
    throw new CommissionSettlementStateError('Settlement funding must come from a completed PAY');
  }
  if (
    facts.fundingCommandPrincipalId !== facts.orderBuyerId ||
    facts.fundingCommandSubjectNamespace !== 'commission-order-payment' ||
    facts.fundingCommandSubjectKey !== String(facts.orderPaymentId) ||
    facts.reservationHolderBindingNamespace !== 'user' ||
    facts.reservationHolderBindingKey !== String(facts.orderBuyerId)
  ) {
    throw new CommissionSettlementStateError(
      'Settlement PAY principal, payment subject, and buyer holder must agree',
    );
  }
  if (
    facts.orderAmount !== facts.paymentAmount ||
    facts.orderAmount !== facts.reservationTargetAmount ||
    facts.orderAmount !== facts.fundingTransferAmount
  ) {
    throw new CommissionSettlementStateError('Settlement funded amount must equal the paid Order');
  }
  if (facts.fundingTransferToAccountId !== facts.pointEscrowAccountId) {
    throw new CommissionSettlementStateError('Settlement funding must target the reservation escrow');
  }

  return {
    commandRequest: {
      flowId: facts.flowId,
      flowKind: 'COMMISSION' as const,
      kind: 'SETTLE' as const,
      principalId: input.actorId,
      idempotencyKey: input.commandKey,
      subjectNamespace: COMMISSION_CONTRACT_NAMESPACE,
      subjectKey: String(input.contractId),
    },
    operationRequest: { kind: 'SETTLE' as const, actionKind: 'SWAP' as const },
    swap: {
      flowId: facts.flowId,
      reservationId: facts.reservationId,
      beneficiaryHolderId: facts.beneficiaryHolderId,
      amount: facts.reservationTargetAmount,
      pointLeg: {
        currency: 'POINT' as const,
        fromAccountId: facts.pointEscrowAccountId,
        toAccountId: facts.pointSettledAccountId,
      },
      incomeLeg: {
        currency: 'INCOME' as const,
        fromAccountId: facts.incomeIssuerAccountId,
        toAccountId: facts.incomeAvailableAccountId,
      },
      incomeLot: {
        accountId: facts.incomeAvailableAccountId,
        currency: 'INCOME' as const,
        sourceKind: 'COMMISSION_SETTLEMENT' as const,
        originalAmount: facts.reservationTargetAmount,
      },
    },
  };
}

export type CommissionSettlementPlan = ReturnType<typeof planCommissionSettlement>;

interface StoredCommissionSettlementCommand {
  flowId: string;
  flowKind: string;
  kind: string;
  payloadHash: string;
  subjectNamespace: string;
  subjectKey: string;
  operationDbId: string | null;
  operationId: string | null;
  referenceId: string;
  commandId: string;
}

export function planCommissionSettlementStart<T extends StoredCommissionSettlementCommand>(
  existing: T | null,
  completed: T | null,
  requested: Pick<T, 'flowKind' | 'kind' | 'payloadHash' | 'subjectNamespace' | 'subjectKey'>,
) {
  const stored = existing ?? completed;
  if (!stored) return { kind: 'PROCEED' as const };
  if (
    stored.flowKind !== requested.flowKind ||
    stored.kind !== requested.kind ||
    stored.payloadHash !== requested.payloadHash ||
    stored.subjectNamespace !== requested.subjectNamespace ||
    stored.subjectKey !== requested.subjectKey
  ) {
    throw new CommissionSettlementStateError('Settlement command key identity mismatch');
  }
  if (!stored.operationDbId || !stored.operationId) {
    throw new CommissionSettlementStateError('Settlement command has no completed operation');
  }
  return {
    kind: existing ? ('REPLAY' as const) : ('ALIAS' as const),
    identity: stored as T & { operationDbId: string; operationId: string },
  };
}

export function assertCommissionSettlementHolderIdentity(locked: number, actual: number): void {
  if (locked !== actual) {
    throw new CommissionSettlementStateError('Commission worker financial holder changed');
  }
}

export function assertCommissionSettlementReplayFlow(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new CommissionSettlementStateError('Stored settlement belongs to another commission flow');
  }
}

export interface CommissionSettlementResult {
  contractId: number;
  reservationId: number;
  incomeLotId: number;
  referenceId: string;
  commandId: string;
  operationId: string;
  replayed: boolean;
}
