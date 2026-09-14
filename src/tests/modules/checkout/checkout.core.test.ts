import { describe, expect, it } from 'vitest';
import {
  assertLockedCheckoutTargets,
  CheckoutActorError,
  CheckoutStateError,
  planCheckout,
  type CheckoutFacts,
} from '../../../modules/checkout/checkout.core.js';
import { ConcurrentUpdateError } from '../../../foundation/errors.js';

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

describe('planCheckout', () => {
  it('rejects an actor other than the Order buyer', () => {
    expect(() => planCheckout(facts, { actorId: 3 })).toThrow(CheckoutActorError);
  });

  it('rejects an OrderPayment that is no longer pending', () => {
    expect(() =>
      planCheckout({ ...facts, paymentState: 'PAID' }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('rejects a payment amount that differs from the Order snapshot', () => {
    expect(() =>
      planCheckout({ ...facts, paymentAmount: 499 }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('rejects a slot owned by a different worker', () => {
    expect(() =>
      planCheckout({ ...facts, slotWorkerId: 4 }, { actorId: 1 }),
    ).toThrow(CheckoutStateError);
  });

  it('returns a checkout-owned intent for a payable Order', () => {
    expect(planCheckout(facts, { actorId: 1 })).toEqual({
      financialRequest: {
        referenceId: 'order-payment:20',
        bindingNamespace: 'order-payment',
        bindingKey: '20',
        holderId: 50,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        amount: 500,
      },
      contract: { orderId: 10, buyerId: 1, workerId: 2 },
      paidOrder: { orderId: 10, orderPaymentId: 20 },
      occupiedSlot: { slotId: 30, workerId: 2 },
    });
  });
});

describe('assertLockedCheckoutTargets', () => {
  it('rejects facts that moved to a buyer, slot, or holder we did not lock', () => {
    const locked = { buyerId: 1, slotId: 30, financialHolderId: 50 };
    expect(() =>
      assertLockedCheckoutTargets(locked, { ...locked, financialHolderId: 51 }),
    ).toThrow(ConcurrentUpdateError);
  });

  it('accepts facts that still belong to every locked target', () => {
    const locked = { buyerId: 1, slotId: 30, financialHolderId: 50 };
    expect(() => assertLockedCheckoutTargets(locked, locked)).not.toThrow();
  });
});
