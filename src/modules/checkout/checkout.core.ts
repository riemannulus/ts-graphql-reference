import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';

export interface CheckoutInput {
  orderPaymentId: number;
  actorId: number;
  commandKey: string;
}

export interface OrderPaymentFacts {
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

export interface CheckoutFacts extends OrderPaymentFacts {
  commissionWorkerId: number;
  commissionPrice: number;
  slotWorkerId: number;
  slotState: string;
  financialHolderId: number;
}

export interface FinancialRequest {
  referenceId: string;
  bindingNamespace: string;
  bindingKey: string;
  holderId: number;
  purpose: 'COMMISSION_PAYMENT';
  currency: 'POINT';
  amount: number;
}

export interface CheckoutPlan {
  financialRequest: FinancialRequest;
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

export interface CheckoutResult {
  orderId: number;
  orderPaymentId: number;
  contractId: number;
  reservationId: number;
  replayed: boolean;
}

type EconomicResult = Omit<CheckoutResult, 'replayed'>;

interface ExistingCheckout {
  payloadHash: string;
  buyerId: number;
  result: EconomicResult;
}

export type CheckoutStartPlan =
  | { kind: 'PROCEED' }
  | { kind: 'REPLAY'; result: EconomicResult; saveAlias: boolean };

export class CheckoutActorError extends DomainError {
  constructor() {
    super('Only the Order buyer can complete checkout', 'CHECKOUT_ACTOR_MISMATCH');
  }
}

export class CheckoutStateError extends DomainError {
  constructor(message: string) {
    super(message, 'ORDER_NOT_PAYABLE');
  }
}

export class CheckoutIdempotencyError extends DomainError {
  constructor() {
    super('Checkout command key was already used for a different payload', 'IDEMPOTENCY_MISMATCH');
  }
}

interface CheckoutLockTargets {
  buyerId: number;
  slotId: number;
  financialHolderId: number;
}

export function assertLockedCheckoutTargets(
  locked: CheckoutLockTargets,
  actual: CheckoutLockTargets,
): void {
  if (
    locked.buyerId !== actual.buyerId ||
    locked.slotId !== actual.slotId ||
    locked.financialHolderId !== actual.financialHolderId
  ) {
    throw new ConcurrentUpdateError('checkout lock targets');
  }
}

export function assertCheckoutActor(buyerId: number, actorId: number): void {
  if (buyerId !== actorId) throw new CheckoutActorError();
}

export function assertReplayPayload(storedHash: string, requestedHash: string): void {
  if (storedHash !== requestedHash) throw new CheckoutIdempotencyError();
}

export function planCheckoutStart(
  command: ExistingCheckout | null,
  payment: ExistingCheckout | null,
  requestedHash: string,
  actorId: number,
): CheckoutStartPlan {
  if (command) {
    assertReplayPayload(command.payloadHash, requestedHash);
    return { kind: 'REPLAY', result: command.result, saveAlias: false };
  }
  if (payment) {
    assertCheckoutActor(payment.buyerId, actorId);
    return { kind: 'REPLAY', result: payment.result, saveAlias: true };
  }
  return { kind: 'PROCEED' };
}

export function planCheckout(facts: CheckoutFacts, input: { actorId: number }): CheckoutPlan {
  assertCheckoutActor(facts.buyerId, input.actorId);
  if (facts.orderState !== 'REQUESTED' || facts.paymentState !== 'PENDING') {
    throw new CheckoutStateError('Order and payment must both be pending');
  }
  if (facts.slotState !== 'AVAILABLE') {
    throw new CheckoutStateError('Commission slot is not available');
  }
  if (facts.commissionWorkerId !== facts.slotWorkerId) {
    throw new CheckoutStateError('Commission slot belongs to a different worker');
  }
  if (
    facts.orderCurrency !== 'POINT' ||
    facts.paymentCurrency !== 'POINT' ||
    facts.orderAmount !== facts.paymentAmount ||
    facts.orderAmount !== facts.commissionPrice
  ) {
    throw new CheckoutStateError('Order, payment, and commission price must match');
  }

  return {
    financialRequest: {
      referenceId: facts.referenceId,
      bindingNamespace: 'order-payment',
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
