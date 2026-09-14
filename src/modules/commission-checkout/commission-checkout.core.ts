import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';

export const COMMISSION_ORDER_PAYMENT_NAMESPACE = 'commission-order-payment';
export const COMMISSION_COMMAND_KINDS = [
  'PAY',
  'EXTRA_PAY',
  'SETTLE',
  'REFUND',
  'CANCEL',
] as const;

export interface CommissionCheckoutInput {
  orderPaymentId: number;
  actorId: number;
  commandKey: string;
}

interface CommissionCheckoutPaymentFacts {
  orderId: number;
  orderPaymentId: number;
  buyerId: number;
  commissionTypeId: number;
  slotId: number;
  flowId: string;
  orderAmount: number;
  paymentAmount: number;
  orderCurrency: string;
  paymentCurrency: string;
  orderState: string;
  paymentState: string;
}

export interface CommissionCheckoutFacts extends CommissionCheckoutPaymentFacts {
  commissionWorkerId: number;
  commissionPrice: number;
  slotWorkerId: number;
  slotState: string;
  financialHolderId: number;
}

interface CommissionPaymentReservationRequest {
  flowId: string;
  bindingNamespace: string;
  bindingKey: string;
  holderId: number;
  purpose: 'COMMISSION_PAYMENT';
  currency: 'POINT';
  amount: number;
}

export interface CommissionCheckoutPlan {
  commandRequest: {
    flowId: string;
    flowKind: 'COMMISSION';
    kind: 'PAY';
    principalId: number;
    idempotencyKey: string;
    subjectNamespace: typeof COMMISSION_ORDER_PAYMENT_NAMESPACE;
    subjectKey: string;
  };
  operationRequest: {
    kind: 'PAY';
    actionKind: 'TRANSFER';
  };
  financialRequest: CommissionPaymentReservationRequest;
  contract: {
    orderId: number;
    flowId: string;
    buyerId: number;
    workerId: number;
  };
  paidOrder: {
    orderId: number;
    orderPaymentId: number;
    flowId: string;
  };
  occupiedSlot: {
    slotId: number;
    workerId: number;
  };
}

export interface CommissionCheckoutResult {
  orderId: number;
  orderPaymentId: number;
  contractId: number;
  reservationId: number;
  referenceId: string;
  commandId: string;
  operationId: string;
  replayed: boolean;
}

type CommissionCheckoutEconomicResult = Omit<CommissionCheckoutResult, 'replayed'>;

interface ExistingCommissionCheckout {
  payloadHash: string;
  buyerId: number;
  result: CommissionCheckoutEconomicResult;
}

type CommissionCheckoutStartPlan =
  | { kind: 'PROCEED' }
  | { kind: 'REPLAY'; result: CommissionCheckoutEconomicResult; saveAlias: boolean };

export class CommissionCheckoutActorError extends DomainError {
  constructor() {
    super(
      'Only the Order buyer can complete commission checkout',
      'COMMISSION_CHECKOUT_ACTOR_MISMATCH',
    );
  }
}

export class CommissionCheckoutStateError extends DomainError {
  constructor(message: string) {
    super(message, 'ORDER_NOT_PAYABLE');
  }
}

export class CommissionCheckoutIdempotencyError extends DomainError {
  constructor() {
    super(
      'Commission checkout command key was already used for a different payload',
      'IDEMPOTENCY_MISMATCH',
    );
  }
}

interface CommissionCheckoutLockTargets {
  buyerId: number;
  slotId: number;
  financialHolderId: number;
}

export function assertLockedCommissionCheckoutTargets(
  locked: CommissionCheckoutLockTargets,
  actual: CommissionCheckoutLockTargets,
): void {
  if (
    locked.buyerId !== actual.buyerId ||
    locked.slotId !== actual.slotId ||
    locked.financialHolderId !== actual.financialHolderId
  ) {
    throw new ConcurrentUpdateError('commission checkout lock targets');
  }
}

function assertCommissionCheckoutActor(buyerId: number, actorId: number): void {
  if (buyerId !== actorId) throw new CommissionCheckoutActorError();
}

export function planCommissionCheckoutCommand(input: CommissionCheckoutInput) {
  return {
    flowKind: 'COMMISSION' as const,
    kind: 'PAY' as const,
    principalId: input.actorId,
    idempotencyKey: input.commandKey,
    subjectNamespace: COMMISSION_ORDER_PAYMENT_NAMESPACE,
    subjectKey: String(input.orderPaymentId),
  } as const;
}

export function assertCommissionCheckoutReplayIdentity(
  stored: {
    flowKind: string;
    kind: string;
    payloadHash: string;
    subjectNamespace: string;
    subjectKey: string;
  },
  requested: {
    flowKind: string;
    kind: string;
    payloadHash: string;
    subjectNamespace: string;
    subjectKey: string;
  },
): void {
  if (
    stored.flowKind !== requested.flowKind ||
    stored.kind !== requested.kind ||
    stored.payloadHash !== requested.payloadHash ||
    stored.subjectNamespace !== requested.subjectNamespace ||
    stored.subjectKey !== requested.subjectKey
  ) {
    throw new CommissionCheckoutIdempotencyError();
  }
}

export function planCommissionCheckoutStart(
  command: ExistingCommissionCheckout | null,
  payment: ExistingCommissionCheckout | null,
  requestedHash: string,
  actorId: number,
): CommissionCheckoutStartPlan {
  if (command) {
    if (command.payloadHash !== requestedHash) throw new CommissionCheckoutIdempotencyError();
    return { kind: 'REPLAY', result: command.result, saveAlias: false };
  }
  if (payment) {
    assertCommissionCheckoutActor(payment.buyerId, actorId);
    return { kind: 'REPLAY', result: payment.result, saveAlias: true };
  }
  return { kind: 'PROCEED' };
}

export function planCommissionCheckout(
  facts: CommissionCheckoutFacts,
  input: CommissionCheckoutInput,
): CommissionCheckoutPlan {
  assertCommissionCheckoutActor(facts.buyerId, input.actorId);
  if (facts.orderState !== 'REQUESTED' || facts.paymentState !== 'PENDING') {
    throw new CommissionCheckoutStateError('Order and payment must both be pending');
  }
  if (facts.slotState !== 'AVAILABLE') {
    throw new CommissionCheckoutStateError('Commission slot is not available');
  }
  if (facts.commissionWorkerId !== facts.slotWorkerId) {
    throw new CommissionCheckoutStateError('Commission slot belongs to a different worker');
  }
  if (
    facts.orderCurrency !== 'POINT' ||
    facts.paymentCurrency !== 'POINT' ||
    facts.orderAmount !== facts.paymentAmount ||
    facts.orderAmount !== facts.commissionPrice
  ) {
    throw new CommissionCheckoutStateError('Order, payment, and commission price must match');
  }

  return {
    commandRequest: {
      flowId: facts.flowId,
      ...planCommissionCheckoutCommand(input),
    },
    operationRequest: { kind: 'PAY', actionKind: 'TRANSFER' },
    financialRequest: {
      flowId: facts.flowId,
      bindingNamespace: COMMISSION_ORDER_PAYMENT_NAMESPACE,
      bindingKey: String(facts.orderPaymentId),
      holderId: facts.financialHolderId,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      amount: facts.paymentAmount,
    },
    contract: {
      orderId: facts.orderId,
      flowId: facts.flowId,
      buyerId: facts.buyerId,
      workerId: facts.commissionWorkerId,
    },
    paidOrder: {
      orderId: facts.orderId,
      orderPaymentId: facts.orderPaymentId,
      flowId: facts.flowId,
    },
    occupiedSlot: {
      slotId: facts.slotId,
      workerId: facts.commissionWorkerId,
    },
  };
}
