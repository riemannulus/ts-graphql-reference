import { describe, expect, it } from 'vitest';
import {
  InsufficientPointError,
  parsePointChargeState,
  planCharge,
  planSpend,
  PointAmountNotPositiveError,
  PointLedgerInconsistencyError,
  UnknownPointChargeStateError,
} from '../../../modules/point/point.core.js';

const snapshot = (paid: number, free: number) => ({
  paidAmount: paid,
  freeAmount: free,
  totalAmount: paid + free,
});

describe('planSpend', () => {
  it('splits paid-first and allocates FIFO across charges', () => {
    const plan = planSpend(
      snapshot(150, 100),
      [
        { id: 1, unspentPaid: 100, unspentFree: 0 },
        { id: 2, unspentPaid: 50, unspentFree: 100 },
      ],
      200,
    );

    expect(plan.paidUsage).toBe(150); // all paid consumed before any free
    expect(plan.freeUsage).toBe(50);
    expect(plan.allocations).toEqual([
      {
        chargeId: 1,
        paid: 100,
        free: 0,
        assumed: { unspentPaid: 100, unspentFree: 0 },
        depleted: true,
      },
      {
        chargeId: 2,
        paid: 50,
        free: 50,
        assumed: { unspentPaid: 50, unspentFree: 100 },
        depleted: false,
      },
    ]);
    expect(plan.balanceAfter).toEqual(snapshot(0, 50));
  });

  it('skips charges that contribute nothing', () => {
    const plan = planSpend(
      snapshot(0, 20),
      [
        { id: 1, unspentPaid: 0, unspentFree: 0 },
        { id: 2, unspentPaid: 0, unspentFree: 20 },
      ],
      20,
    );
    expect(plan.allocations.map((a) => a.chargeId)).toEqual([2]);
  });

  it('rejects a non-positive or fractional amount', () => {
    const world = snapshot(10, 0);
    expect(() => planSpend(world, [], 0)).toThrow(PointAmountNotPositiveError);
    expect(() => planSpend(world, [], -5)).toThrow(PointAmountNotPositiveError);
    expect(() => planSpend(world, [], 1.5)).toThrow(PointAmountNotPositiveError);
  });

  it('rejects a spend beyond the balance', () => {
    expect(() =>
      planSpend(snapshot(5, 5), [{ id: 1, unspentPaid: 5, unspentFree: 5 }], 11),
    ).toThrow(InsufficientPointError);
  });

  it('detects a corrupt ledger (snapshot not covered by charges) before any write', () => {
    // Snapshot promises 100 paid points but no charge carries them.
    expect(() => planSpend(snapshot(100, 0), [], 50)).toThrow(PointLedgerInconsistencyError);
  });
});

describe('planCharge', () => {
  it('accepts a one-sided top-up and totals it', () => {
    expect(planCharge({ paidAmount: 100, freeAmount: 0 })).toEqual({
      paidAmount: 100,
      freeAmount: 0,
      totalAmount: 100,
    });
  });

  it('rejects zero, negative, and fractional inputs', () => {
    expect(() => planCharge({ paidAmount: 0, freeAmount: 0 })).toThrow(
      PointAmountNotPositiveError,
    );
    expect(() => planCharge({ paidAmount: -1, freeAmount: 5 })).toThrow(
      PointAmountNotPositiveError,
    );
    expect(() => planCharge({ paidAmount: 0.5, freeAmount: 0.5 })).toThrow(
      PointAmountNotPositiveError,
    );
  });
});

describe('parsePointChargeState', () => {
  it('accepts the known states and rejects anything else', () => {
    expect(parsePointChargeState('USABLE')).toBe('USABLE');
    expect(parsePointChargeState('CONSUMED')).toBe('CONSUMED');
    expect(() => parsePointChargeState('EXPIRED')).toThrow(UnknownPointChargeStateError);
  });
});
