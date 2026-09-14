import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';

const COMMISSION_ORDER_PAYMENT_BINDING_NAMESPACE = 'order-payment';

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
  referenceId: string;
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
  referenceId: string;
  bindingNamespace: string;
  bindingKey: string;
  holderId: number;
  purpose: 'COMMISSION_PAYMENT';
  currency: 'POINT';
  amount: number;
}

export interface CommissionCheckoutPlan {
  financialRequest: CommissionPaymentReservationRequest;
  contract: {
    orderId: number;
    buyerId: number;
    workerId: number;
  };
  paidOrder: {
    orderId: number;
    orderPaymentId: number;
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

function assertCommissionCheckoutReplayPayload(
  storedHash: string,
  requestedHash: string,
): void {
  if (storedHash !== requestedHash) throw new CommissionCheckoutIdempotencyError();
}

export function planCommissionCheckoutStart(
  command: ExistingCommissionCheckout | null,
  payment: ExistingCommissionCheckout | null,
  requestedHash: string,
  actorId: number,
): CommissionCheckoutStartPlan {
  if (command) {
    assertCommissionCheckoutReplayPayload(command.payloadHash, requestedHash);
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
  input: { actorId: number },
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
    financialRequest: {
      referenceId: facts.referenceId,
      bindingNamespace: COMMISSION_ORDER_PAYMENT_BINDING_NAMESPACE,
      bindingKey: String(facts.orderPaymentId),
      holderId: facts.financialHolderId,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      amount: facts.paymentAmount,
    },
    contract: {
      orderId: facts.orderId,
      buyerId: facts.buyerId,
      workerId: facts.commissionWorkerId,
    },
    paidOrder: {
      orderId: facts.orderId,
      orderPaymentId: facts.orderPaymentId,
    },
    occupiedSlot: {
      slotId: facts.slotId,
      workerId: facts.commissionWorkerId,
    },
  };
}
