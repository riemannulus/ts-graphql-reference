import { DomainError } from '../../foundation/errors.js';
import type {
  CheckoutFacts,
  ContractFormation,
  PaymentIntent,
  ReservationReceipt,
} from './checkout.port.js';

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

export class ReceiptMismatchError extends DomainError {
  constructor() {
    super('Financial reservation receipt does not match the payment intent', 'RECEIPT_MISMATCH');
  }
}

export function validatePaymentIntent(
  facts: CheckoutFacts,
  input: { actorId: number },
): PaymentIntent {
  if (facts.buyerId !== input.actorId) throw new CheckoutActorError();
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
    commissionTypeId: facts.commissionTypeId,
    slotId: facts.slotId,
    financialHolderId: facts.financialHolderId,
    titleSnapshot: facts.titleSnapshot,
    holderBinding: { namespace: 'user', key: String(facts.buyerId) },
    financialRequest: {
      referenceId: facts.referenceId,
      bindingNamespace: 'order-payment',
      bindingKey: String(facts.orderPaymentId),
      holderId: facts.financialHolderId,
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
    reservationId: receipt.reservationId,
  };
}
