import { DomainError } from '../../foundation/errors.js';

export const COMMISSION_CONTRACT_NAMESPACE = 'commission-contract';

export interface CommissionSettlementInput {
  contractId: number;
  actorId: number;
  commandKey: string;
}

export interface CommissionSettlementWorld {
  contract: { id: number; orderId: number; flowId: string; workerId: number };
  order: {
    id: number;
    buyerId: number;
    flowId: string;
    state: string;
    amount: number;
    currency: string;
  };
  payment: {
    id: number;
    flowId: string;
    state: string;
    amount: number;
    currency: string;
    fundingLink: { reservationId: number; flowId: string };
  };
  funding: {
    reservation: {
      id: number;
      flowId: string;
      state: string;
      currency: string;
      targetAmount: number;
      holderBinding: { namespace: string; key: string };
      escrowAccountId: number;
    };
    transfer: {
      flowId: string;
      currency: string;
      amount: number;
      toAccountId: number;
    };
    provenance: {
      action: { operationKind: string };
      operation: { id: string; flowId: string; kind: string };
      command: {
        flowId: string;
        kind: string;
        principalId: number;
        subject: { namespace: string; key: string };
        resultOperationId: string | null;
      };
    };
  };
  accounts: {
    beneficiaryHolderId: number;
    point: { settledAccountId: number };
    income: { issuerAccountId: number; availableAccountId: number };
  };
}

export class CommissionSettlementStateError extends DomainError {
  constructor(message: string) {
    super(message, 'COMMISSION_NOT_SETTLEABLE');
  }
}

export function planCommissionSettlement(
  world: CommissionSettlementWorld,
  input: CommissionSettlementInput,
) {
  const { contract, order, payment, funding, accounts } = world;
  const { reservation, transfer, provenance } = funding;

  if (contract.id !== input.contractId) {
    throw new CommissionSettlementStateError('Contract identity changed');
  }
  if (contract.orderId !== order.id) {
    throw new CommissionSettlementStateError('Contract Order identity changed');
  }
  if (contract.workerId !== input.actorId) {
    throw new CommissionSettlementStateError('Only the contract worker can settle commission');
  }
  if (order.state !== 'PAID') {
    throw new CommissionSettlementStateError('Commission Order must be paid before settlement');
  }
  if (payment.state !== 'PAID') {
    throw new CommissionSettlementStateError('Commission payment must be paid before settlement');
  }
  if (reservation.state !== 'HELD') {
    throw new CommissionSettlementStateError('Commission POINT must still be held for settlement');
  }
  if (
    order.currency !== 'POINT' ||
    payment.currency !== 'POINT' ||
    reservation.currency !== 'POINT' ||
    transfer.currency !== 'POINT' ||
    reservation.targetAmount <= 0
  ) {
    throw new CommissionSettlementStateError('Settlement input must be positive POINT');
  }
  if (
    contract.flowId !== order.flowId ||
    contract.flowId !== payment.flowId ||
    contract.flowId !== payment.fundingLink.flowId ||
    contract.flowId !== reservation.flowId ||
    contract.flowId !== transfer.flowId
  ) {
    throw new CommissionSettlementStateError('Settlement funding must belong to the Contract flow');
  }
  if (payment.fundingLink.reservationId !== reservation.id) {
    throw new CommissionSettlementStateError('Settlement must use the Order-owned reservation link');
  }
  if (
    provenance.action.operationKind !== 'PAY' ||
    provenance.operation.kind !== 'PAY' ||
    provenance.command.kind !== 'PAY' ||
    provenance.operation.id !== provenance.command.resultOperationId ||
    provenance.operation.flowId !== contract.flowId ||
    provenance.command.flowId !== contract.flowId
  ) {
    throw new CommissionSettlementStateError('Settlement funding must come from a completed PAY');
  }
  if (
    provenance.command.principalId !== order.buyerId ||
    provenance.command.subject.namespace !== 'commission-order-payment' ||
    provenance.command.subject.key !== String(payment.id) ||
    reservation.holderBinding.namespace !== 'user' ||
    reservation.holderBinding.key !== String(order.buyerId)
  ) {
    throw new CommissionSettlementStateError(
      'Settlement PAY principal, payment subject, and buyer holder must agree',
    );
  }
  if (
    order.amount !== payment.amount ||
    order.amount !== reservation.targetAmount ||
    order.amount !== transfer.amount
  ) {
    throw new CommissionSettlementStateError('Settlement funded amount must equal the paid Order');
  }
  if (transfer.toAccountId !== reservation.escrowAccountId) {
    throw new CommissionSettlementStateError('Settlement funding must target the reservation escrow');
  }

  return {
    commandRequest: {
      flowId: contract.flowId,
      flowKind: 'COMMISSION' as const,
      kind: 'SETTLE' as const,
      principalId: input.actorId,
      idempotencyKey: input.commandKey,
      subjectNamespace: COMMISSION_CONTRACT_NAMESPACE,
      subjectKey: String(input.contractId),
    },
    operationRequest: { kind: 'SETTLE' as const, actionKind: 'SWAP' as const },
    swap: {
      flowId: contract.flowId,
      reservationId: reservation.id,
      beneficiaryHolderId: accounts.beneficiaryHolderId,
      amount: reservation.targetAmount,
      pointLeg: {
        currency: 'POINT' as const,
        fromAccountId: reservation.escrowAccountId,
        toAccountId: accounts.point.settledAccountId,
      },
      incomeLeg: {
        currency: 'INCOME' as const,
        fromAccountId: accounts.income.issuerAccountId,
        toAccountId: accounts.income.availableAccountId,
      },
      incomeLot: {
        accountId: accounts.income.availableAccountId,
        currency: 'INCOME' as const,
        sourceKind: 'COMMISSION_SETTLEMENT' as const,
        originalAmount: reservation.targetAmount,
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
