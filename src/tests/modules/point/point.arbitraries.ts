import { fc } from '@fast-check/vitest';
import type {
  ChargeBalance,
  ExpirableCharge,
  PointSnapshot,
} from '../../../modules/point/point.core.js';

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

// --- Expiry ----------------------------------------------------------------

/**
 * A fixed reference "now" for the expiry laws. Deterministic given the
 * fast-check seed (no `Date.now()` in the generator), and the charge dates below
 * are spread around it so a run exercises BOTH sides of the deadline.
 */
export const EXPIRY_NOW = new Date('2026-06-15T00:00:00.000Z');
const NOW_MS = EXPIRY_NOW.getTime();
const DAY_MS = 86_400_000;

/**
 * One expirable (USABLE) charge with a `chargedAt` within ~±2 years of
 * `EXPIRY_NOW`, so relative to the 365-day deadline some charges are due and some
 * are not. `id` is assigned by `arbExpiryWorld` so ids are unique within a world.
 */
export const arbExpirableCharge: fc.Arbitrary<ExpirableCharge> = fc.record({
  id: fc.constant(0),
  unspentPaid: fc.integer({ min: 0, max: MAX_AMOUNT }),
  unspentFree: fc.integer({ min: 0, max: MAX_AMOUNT }),
  chargedAt: fc.integer({ min: -730, max: 730 }).map((d) => new Date(NOW_MS + d * DAY_MS)),
});

/**
 * A CONSISTENT expiry world: charges plus the balance snapshot derived from their
 * unspent remainders (the state a correct system can be in) — the precondition
 * `planExpiry` is designed around.
 */
export const arbExpiryWorld: fc.Arbitrary<{ snapshot: PointSnapshot; charges: ExpirableCharge[] }> =
  fc.array(arbExpirableCharge, { maxLength: 8 }).map((partials) => {
    const charges = partials.map((c, i) => ({ ...c, id: i + 1 }));
    const paidAmount = charges.reduce((sum, c) => sum + c.unspentPaid, 0);
    const freeAmount = charges.reduce((sum, c) => sum + c.unspentFree, 0);
    return {
      snapshot: { paidAmount, freeAmount, totalAmount: paidAmount + freeAmount },
      charges,
    };
  });
