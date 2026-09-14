import { describe, expect, it } from 'vitest';
import {
  buildContractFormation,
  CheckoutActorError,
  CheckoutStateError,
  ReceiptMismatchError,
  validatePaymentIntent,
} from '../../../modules/checkout/checkout.core.js';
import type { CheckoutFacts, ReservationReceipt } from '../../../modules/checkout/checkout.port.js';

const facts: CheckoutFacts = {
  orderId: 10,
  orderPaymentId: 20,
  buyerId: 1,
  commissionWorkerId: 2,
  commissionPrice: 500,
  slotWorkerId: 2,
  commissionTypeId: 40,
  slotId: 30,
  financialHolderId: 50,
  referenceId: 'order-payment:20',
  orderAmount: 500,
  paymentAmount: 500,
  orderCurrency: 'POINT',
  paymentCurrency: 'POINT',
  orderState: 'REQUESTED',
  paymentState: 'PENDING',
  slotState: 'AVAILABLE',
};

describe('validatePaymentIntent', () => {
  it('rejects an actor other than the Order buyer', () => {
    expect(() => validatePaymentIntent(facts, { actorId: 3 })).toThrow(CheckoutActorError);
  });

  it('rejects an OrderPayment that is no longer pending', () => {
    expect(() =>
      validatePaymentIntent({ ...facts, paymentState: 'PAID' }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('rejects a payment amount that differs from the Order snapshot', () => {
    expect(() =>
      validatePaymentIntent({ ...facts, paymentAmount: 499 }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('rejects a slot owned by a different worker', () => {
    expect(() =>
      validatePaymentIntent({ ...facts, slotWorkerId: 4 }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('returns a checkout-owned intent for a payable Order', () => {
    expect(validatePaymentIntent(facts, { actorId: 1 })).toEqual({
      orderId: 10,
      orderPaymentId: 20,
      buyerId: 1,
      workerId: 2,
      slotId: 30,
      financialRequest: {
        referenceId: 'order-payment:20',
        bindingNamespace: 'order-payment',
        bindingKey: '20',
        holderId: 50,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        amount: 500,
      },
    });
  });
});

describe('buildContractFormation', () => {
  const intent = validatePaymentIntent(facts, { actorId: 1 });
  const receipt: ReservationReceipt = {
    reservationId: 60,
    referenceId: 'order-payment:20',
    bindingNamespace: 'order-payment',
    bindingKey: '20',
    holderId: 50,
    purpose: 'COMMISSION_PAYMENT',
    currency: 'POINT',
    amount: 500,
  };

  it('rejects a receipt for a different holder', () => {
    expect(() => buildContractFormation(intent, { ...receipt, holderId: 51 })).toThrow(
      ReceiptMismatchError,
    );
  });

  it('builds formation data only after verifying the reservation receipt', () => {
    expect(buildContractFormation(intent, receipt)).toEqual({
      orderId: 10,
      buyerId: 1,
      workerId: 2,
    });
  });
});
