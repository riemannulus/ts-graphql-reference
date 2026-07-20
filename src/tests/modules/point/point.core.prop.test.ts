import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import {
  InsufficientPointError,
  isValidPointAmount,
  planSpend,
  planTransfer,
  PointAmountNotPositiveError,
  PointTransferToSelfError,
  type SpendPlan,
} from '../../../modules/point/point.core.js';
import { arbLedger, arbSpendAmount } from './point.arbitraries.js';

// The laws of the spend decision. Each property runs against hundreds of
// random consistent ledgers — no database involved (that is the point of
// keeping the decision pure).

const sufficient = ({ snapshot }: { snapshot: { totalAmount: number } }, amount: number) =>
  snapshot.totalAmount >= amount;

function plannedOrRejected(
  ledger: { snapshot: Parameters<typeof planSpend>[0]; charges: Parameters<typeof planSpend>[1] },
  amount: number,
): SpendPlan | 'rejected' {
  try {
    return planSpend(ledger.snapshot, ledger.charges, amount);
  } catch (error) {
    if (error instanceof InsufficientPointError || error instanceof PointAmountNotPositiveError) {
      return 'rejected';
    }
    throw error; // a consistent ledger must never trip the corruption path
  }
}

test.prop([arbLedger, arbSpendAmount])(
  'conservation: allocations sum exactly to the requested amount and its paid/free split',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    const paid = plan.allocations.reduce((sum, a) => sum + a.paid, 0);
    const free = plan.allocations.reduce((sum, a) => sum + a.free, 0);
    expect(paid).toBe(plan.paidUsage);
    expect(free).toBe(plan.freeUsage);
    expect(paid + free).toBe(amount);
  },
);

test.prop([arbLedger, arbSpendAmount])(
  'paid-first: free points are only touched once every paid point is consumed',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    if (plan.freeUsage > 0) {
      expect(plan.paidUsage).toBe(ledger.snapshot.paidAmount);
    }
  },
);

test.prop([arbLedger, arbSpendAmount])(
  'FIFO: allocations are an in-order subsequence of the charges',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    const order = ledger.charges.map((c) => c.id);
    const allocated = plan.allocations.map((a) => a.chargeId);
    const positions = allocated.map((id) => order.indexOf(id));
    expect(positions.every((p, i) => p >= 0 && (i === 0 || positions[i - 1]! < p))).toBe(true);
  },
);

test.prop([arbLedger, arbSpendAmount])(
  'no overspend: an allocation never exceeds what the plan assumed the charge held',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    for (const a of plan.allocations) {
      expect(a.paid).toBeLessThanOrEqual(a.assumed.unspentPaid);
      expect(a.free).toBeLessThanOrEqual(a.assumed.unspentFree);
      expect(a.paid + a.free).toBeGreaterThan(0);
    }
  },
);

test.prop([arbLedger, arbSpendAmount])(
  'depletion: depleted marks exactly the charges whose remainder hits zero',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    for (const a of plan.allocations) {
      const remaining = a.assumed.unspentPaid + a.assumed.unspentFree - a.paid - a.free;
      expect(a.depleted).toBe(remaining === 0);
    }
  },
);

test.prop([arbLedger, arbSpendAmount])(
  'balance arithmetic: balanceAfter is the snapshot minus the usages',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount);
    expect(plan.assumedBalance).toEqual(ledger.snapshot);
    expect(plan.balanceAfter).toEqual({
      paidAmount: ledger.snapshot.paidAmount - plan.paidUsage,
      freeAmount: ledger.snapshot.freeAmount - plan.freeUsage,
      totalAmount: ledger.snapshot.totalAmount - amount,
    });
  },
);

test.prop([arbLedger, fc.integer({ min: -1_000, max: 100_000 })])(
  'totality/agreement on a consistent ledger: a plan is returned iff the amount is valid and covered',
  (ledger, amount) => {
    const result = plannedOrRejected(ledger, amount);
    const shouldPlan = isValidPointAmount(amount) && ledger.snapshot.totalAmount >= amount;
    expect(result === 'rejected').toBe(!shouldPlan);
  },
);

// The laws of the transfer decision. planTransfer composes planSpend, so it must
// keep planSpend's guarantees AND add exactly one rule: distinct parties.

test.prop([arbLedger, arbSpendAmount])(
  'conservation: what the sender loses equals what the receiver gains, kind for kind',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const { spend, charge } = planTransfer(1, 2, ledger, amount);
    expect(charge.paidAmount).toBe(spend.paidUsage);
    expect(charge.freeAmount).toBe(spend.freeUsage);
    expect(charge.totalAmount).toBe(amount);
  },
);

test.prop([arbLedger, arbSpendAmount, fc.integer({ min: 1, max: 1_000 })])(
  'the sender side IS planSpend: a transfer plan carries exactly the spend planSpend would',
  (ledger, amount, userId) => {
    fc.pre(sufficient(ledger, amount));
    const { spend } = planTransfer(userId, userId + 1, ledger, amount);
    expect(spend).toEqual(planSpend(ledger.snapshot, ledger.charges, amount));
  },
);

test.prop([arbLedger, arbSpendAmount, fc.integer({ min: 1, max: 1_000 })])(
  'a transfer to self is rejected before any spend is even decided',
  (ledger, amount, userId) => {
    expect(() => planTransfer(userId, userId, ledger, amount)).toThrow(PointTransferToSelfError);
  },
);
