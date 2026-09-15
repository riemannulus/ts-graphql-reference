import { describe, expect, it } from 'vitest';
import {
  assertLockedCommissionCheckoutTargets,
  CommissionCheckoutActorError,
  CommissionCheckoutStateError,
  planCommissionCheckout,
  type CommissionCheckoutWorld,
} from '../../../modules/commission-checkout/commission-checkout.core.js';
import { ConcurrentUpdateError } from '../../../foundation/errors.js';

const facts: CommissionCheckoutWorld = {
  order: {
    id: 10,
    buyerId: 1,
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    amount: 500,
    currency: 'POINT',
    state: 'REQUESTED',
  },
  payment: {
    id: 20,
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    amount: 500,
    currency: 'POINT',
    state: 'PENDING',
  },
  terms: { workerId: 2, price: 500 },
  slot: { id: 30, workerId: 2, state: 'AVAILABLE' },
  funding: { holderId: 50 },
};
const input = { actorId: 1, orderPaymentId: 20, commandKey: 'pay-20' };

describe('planCommissionCheckout', () => {
  it('rejects payment facts for a different input payment', () => {
    expect(() =>
      planCommissionCheckout(
        { ...facts, payment: { ...facts.payment, id: input.orderPaymentId + 1 } },
        input,
      ),
    ).toThrow(CommissionCheckoutStateError);
  });

  it('rejects an actor other than the Order buyer', () => {
    expect(() => planCommissionCheckout(facts, { ...input, actorId: 3 })).toThrow(CommissionCheckoutActorError);
  });

  it('rejects an OrderPayment that is no longer pending', () => {
    expect(() =>
      planCommissionCheckout({ ...facts, payment: { ...facts.payment, state: 'PAID' } }, input),
    ).toThrow(CommissionCheckoutStateError);
  });

  it('rejects a payment amount that differs from the Order snapshot', () => {
    expect(() =>
      planCommissionCheckout({ ...facts, payment: { ...facts.payment, amount: 499 } }, input),
    ).toThrow(CommissionCheckoutStateError);
  });

  it('rejects a slot owned by a different worker', () => {
    expect(() =>
      planCommissionCheckout({ ...facts, slot: { ...facts.slot, workerId: 4 } }, input),
    ).toThrow(CommissionCheckoutStateError);
  });

  it('rejects an Order and payment from different flows', () => {
    expect(() =>
      planCommissionCheckout(
        {
          ...facts,
          payment: {
            ...facts.payment,
            flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ff',
          },
        },
        input,
      ),
    ).toThrow(CommissionCheckoutStateError);
  });

  it('returns a commission-checkout plan for a payable Order', () => {
    expect(planCommissionCheckout(facts, input)).toEqual({
      commandRequest: {
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: 1,
        idempotencyKey: 'pay-20',
        subjectNamespace: 'commission-order-payment',
        subjectKey: '20',
      },
      operationRequest: { kind: 'PAY', actionKind: 'TRANSFER' },
      financialRequest: {
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
        bindingNamespace: 'commission-order-payment',
        bindingKey: '20',
        holderId: 50,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        amount: 500,
      },
      contract: {
        orderId: 10,
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
        buyerId: 1,
        workerId: 2,
      },
      paidOrder: {
        orderId: 10,
        orderPaymentId: 20,
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      },
      occupiedSlot: { slotId: 30, workerId: 2 },
    });
  });
});

describe('assertLockedCommissionCheckoutTargets', () => {
  it('rejects facts that moved to a buyer, slot, or holder we did not lock', () => {
    const locked = { buyerId: 1, slotId: 30, financialHolderId: 50 };
    expect(() =>
      assertLockedCommissionCheckoutTargets(locked, { ...locked, financialHolderId: 51 }),
    ).toThrow(ConcurrentUpdateError);
  });

  it('accepts facts that still belong to every locked target', () => {
    const locked = { buyerId: 1, slotId: 30, financialHolderId: 50 };
    expect(() => assertLockedCommissionCheckoutTargets(locked, locked)).not.toThrow();
  });
});
