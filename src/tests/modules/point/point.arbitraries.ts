import { fc } from '@fast-check/vitest';
import type { ChargeBalance, PointSnapshot } from '../../../modules/point/point.core.js';

const MAX_AMOUNT = 10_000;

/** One charge's spendable remainder (both sides possibly zero). */
export const arbChargeBalance: fc.Arbitrary<Omit<ChargeBalance, 'id'>> = fc.record({
  unspentPaid: fc.integer({ min: 0, max: MAX_AMOUNT }),
  unspentFree: fc.integer({ min: 0, max: MAX_AMOUNT }),
});

/**
 * A CONSISTENT ledger: charges plus the snapshot derived from them — the state
 * a correct system can actually be in, which is `planSpend`'s precondition
 * (an inconsistent ledger is exercised separately for the corruption path).
 */
export const arbLedger: fc.Arbitrary<{ snapshot: PointSnapshot; charges: ChargeBalance[] }> = fc
  .array(arbChargeBalance, { maxLength: 8 })
  .map((partials) => {
    const charges = partials.map((c, i) => ({ ...c, id: i + 1 }));
    const paidAmount = charges.reduce((sum, c) => sum + c.unspentPaid, 0);
    const freeAmount = charges.reduce((sum, c) => sum + c.unspentFree, 0);
    return {
      snapshot: { paidAmount, freeAmount, totalAmount: paidAmount + freeAmount },
      charges,
    };
  });

/** A requested spend amount — any positive integer up to just above MAX total. */
export const arbSpendAmount = fc.integer({ min: 1, max: MAX_AMOUNT * 9 });

/** Valid charge input (at least one side positive). */
export const arbChargeInput = fc
  .record({
    paidAmount: fc.integer({ min: 0, max: MAX_AMOUNT }),
    freeAmount: fc.integer({ min: 0, max: MAX_AMOUNT }),
  })
  .filter((input) => input.paidAmount + input.freeAmount > 0);
