import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import {
  assertBalanceConsistent,
  balancesAgree,
  EXPIRE_AFTER_DAYS,
  InsufficientPointError,
  isValidPointAmount,
  planExpiry,
  planSpend,
  planTransfer,
  PointAmountNotPositiveError,
  PointBalanceDriftError,
  PointTransferToSelfError,
  type SpendPlan,
  sumUsableBalance,
} from '../../../modules/point/point.core.js';
import { addDays, kstEndOfDay } from '../../../foundation/time.js';
import { arbExpiryWorld, arbLedger, arbSpendAmount, EXPIRY_NOW } from './point.arbitraries.js';

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
  'preferFree (rule-change flag): free points are drained first, still conserving the amount',
  (ledger, amount) => {
    fc.pre(sufficient(ledger, amount));
    const plan = planSpend(ledger.snapshot, ledger.charges, amount, { preferFree: true });
    // Free is consumed first; paid covers only the remainder.
    expect(plan.freeUsage).toBe(Math.min(amount, ledger.snapshot.freeAmount));
    expect(plan.paidUsage + plan.freeUsage).toBe(amount);
    if (plan.paidUsage > 0) {
      expect(plan.freeUsage).toBe(ledger.snapshot.freeAmount);
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
    const { spend, charge } = planTransfer(1, 2, ledger, amount, EXPIRY_NOW);
    expect(charge.paidAmount).toBe(spend.paidUsage);
    expect(charge.freeAmount).toBe(spend.freeUsage);
    expect(charge.totalAmount).toBe(amount);
    expect(charge.chargedAt).toBe(EXPIRY_NOW);
  },
);

test.prop([arbLedger, arbSpendAmount, fc.integer({ min: 1, max: 1_000 })])(
  'the sender side IS planSpend: a transfer plan carries exactly the spend planSpend would',
  (ledger, amount, userId) => {
    fc.pre(sufficient(ledger, amount));
    const { spend } = planTransfer(userId, userId + 1, ledger, amount, EXPIRY_NOW);
    expect(spend).toEqual(planSpend(ledger.snapshot, ledger.charges, amount));
  },
);

test.prop([arbLedger, arbSpendAmount, fc.integer({ min: 1, max: 1_000 })])(
  'a transfer to self is rejected before any spend is even decided',
  (ledger, amount, userId) => {
    expect(() => planTransfer(userId, userId, ledger, amount, EXPIRY_NOW)).toThrow(PointTransferToSelfError);
  },
);

// The laws of the expiry decision. `now` is DATA the shell passes in, so a
// property can throw arbitrary instants at it with no clock and no database —
// the whole reason the decision is pure. `EXPIRY_NOW` is a fixed reference; the
// charges' dates straddle the EXPIRE_AFTER_DAYS deadline either way.

const isDue = (chargedAt: Date, now: Date): boolean =>
  kstEndOfDay(addDays(chargedAt, EXPIRE_AFTER_DAYS)).getTime() <= now.getTime();

test.prop([arbExpiryWorld])(
  'agreement: a charge is expired iff now is at/after the end of its KST deadline day',
  (world) => {
    const plan = planExpiry(world, EXPIRY_NOW);
    const expired = new Set(plan.expirations.map((e) => e.chargeId));
    for (const charge of world.charges) {
      expect(expired.has(charge.id)).toBe(isDue(charge.chargedAt, EXPIRY_NOW));
    }
  },
);

test.prop([arbExpiryWorld])(
  'conservation: balanceAfter is the snapshot minus exactly the removed remainders',
  (world) => {
    const plan = planExpiry(world, EXPIRY_NOW);
    const paid = plan.expirations.reduce((sum, e) => sum + e.expiredPaid, 0);
    const free = plan.expirations.reduce((sum, e) => sum + e.expiredFree, 0);
    expect(plan.assumedBalance).toEqual(world.snapshot);
    expect(plan.balanceAfter).toEqual({
      paidAmount: world.snapshot.paidAmount - paid,
      freeAmount: world.snapshot.freeAmount - free,
      totalAmount: world.snapshot.totalAmount - paid - free,
    });
  },
);

test.prop([arbExpiryWorld])(
  'the guard mirrors the charge: each expiration assumes exactly what it removes',
  (world) => {
    const plan = planExpiry(world, EXPIRY_NOW);
    for (const expiration of plan.expirations) {
      expect(expiration.assumed.unspentPaid).toBe(expiration.expiredPaid);
      expect(expiration.assumed.unspentFree).toBe(expiration.expiredFree);
    }
  },
);

test.prop([
  arbExpiryWorld,
  fc.integer({ min: -3650, max: 3650 }).map((d) => new Date(EXPIRY_NOW.getTime() + d * 86_400_000)),
])('totality: returns a plan and never throws, stamping expiredAt with the given now', (world, now) => {
  const plan = planExpiry(world, now);
  expect(plan.expiredAt).toBe(now);
  expect(Array.isArray(plan.expirations)).toBe(true);
});

// The conservation law that the verify job checks against, and its assertion
// wrapper. arbLedger builds the snapshot AS the sum of the charges' unspent, so
// a consistent ledger is exactly the state a correct system reaches.
test.prop([arbLedger])('sumUsableBalance reproduces the balance a consistent ledger implies', (ledger) => {
  expect(sumUsableBalance(ledger.charges)).toEqual(ledger.snapshot);
});

test.prop([arbLedger])('assertBalanceConsistent accepts a consistent ledger', (ledger) => {
  expect(() => assertBalanceConsistent(1, ledger.snapshot, ledger.charges)).not.toThrow();
});

test.prop([arbLedger, fc.integer({ min: 1, max: 1_000 })])(
  'assertBalanceConsistent rejects a stored balance that drifts from the ledger',
  (ledger, drift) => {
    const drifted = { ...ledger.snapshot, paidAmount: ledger.snapshot.paidAmount + drift };
    expect(() => assertBalanceConsistent(1, drifted, ledger.charges)).toThrow(PointBalanceDriftError);
  },
);

test.prop([arbLedger])('balancesAgree is reflexive', (ledger) => {
  expect(balancesAgree(ledger.snapshot, ledger.snapshot)).toBe(true);
});
