import { DomainError } from '../../foundation/errors.js';
import type {
  CheckoutFacts,
  ContractFormation,
  PaymentIntent,
  ReservationReceipt,
} from './checkout.port.js';

interface ExistingCheckout {
  payloadHash: string;
  buyerId: number;
  result: {
    orderId: number;
    orderPaymentId: number;
    contractId: number;
    reservationId: number;
  };
}

export type CheckoutStartPlan =
  | { kind: 'PROCEED' }
  | { kind: 'REPLAY'; result: ExistingCheckout['result']; saveAlias: boolean };

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

export class ReceiptMismatchError extends DomainError {
  constructor() {
    super('Financial reservation receipt does not match the payment intent', 'RECEIPT_MISMATCH');
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

export function validatePaymentIntent(
  facts: CheckoutFacts,
  input: { actorId: number },
): PaymentIntent {
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
    orderId: facts.orderId,
    orderPaymentId: facts.orderPaymentId,
    buyerId: facts.buyerId,
    workerId: facts.commissionWorkerId,
    slotId: facts.slotId,
    financialRequest: {
      referenceId: facts.referenceId,
      bindingNamespace: 'order-payment',
      bindingKey: String(facts.orderPaymentId),
      holderId: facts.financialHolderId,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      amount: facts.paymentAmount,
    },
  };
}

export function buildContractFormation(
  intent: PaymentIntent,
  receipt: ReservationReceipt,
): ContractFormation {
  const request = intent.financialRequest;
  if (
    receipt.referenceId !== request.referenceId ||
    receipt.bindingNamespace !== request.bindingNamespace ||
    receipt.bindingKey !== request.bindingKey ||
    receipt.holderId !== request.holderId ||
    receipt.currency !== request.currency ||
    receipt.amount !== request.amount
  ) {
    throw new ReceiptMismatchError();
  }
  return {
    orderId: intent.orderId,
    buyerId: intent.buyerId,
    workerId: intent.workerId,
  };
}
