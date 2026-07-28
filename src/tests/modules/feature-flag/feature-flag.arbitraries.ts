import { fc } from '@fast-check/vitest';
import { STAGES, type FlagRow, type Stage } from '../../../modules/feature-flag/feature-flag.core.js';

/** A known deploy stage. */
export const arbStage: fc.Arbitrary<Stage> = fc.constantFrom(...STAGES);

// A fixed epoch base so instants are deterministic given the fast-check seed
// (no Date.now()/Math.random() in the generators themselves).
const BASE = 1_700_000_000_000;

/** An instant within ~±1000s of the base epoch. */
export const arbInstant: fc.Arbitrary<Date> = fc
  .integer({ min: -1_000_000, max: 1_000_000 })
  .map((delta) => new Date(BASE + delta));

/** An instant or null (a nullable timestamp column). */
export const arbNullableInstant: fc.Arbitrary<Date | null> = fc.option(arbInstant, { nil: null });

/**
 * An arbitrary flag row: stage is a known stage, a random (likely unknown)
 * string, or null; the window bounds and soft-delete marker are each an instant
 * or null. Deliberately spans invalid states (out-of-order window, unknown
 * stage) so isActive's guards are exercised against worlds a bypassing writer
 * could produce — the predicate must reject them, never throw.
 */
export const arbFlagRow: fc.Arbitrary<FlagRow> = fc.record({
  stage: fc.option(fc.oneof(arbStage, fc.string()), { nil: null }),
  enableAfter: arbNullableInstant,
  disableAfter: arbNullableInstant,
  deletedAt: arbNullableInstant,
});

/** A flag name from a SMALL pool, so stored rows and the declared catalog
 * overlap often — reconcileFlagNames' interesting cases are the intersections. */
export const arbFlagName: fc.Arbitrary<string> = fc.constantFrom('a', 'b', 'c', 'd', 'e');

/** A stored-rows world: names from the pool (repeats allowed — one live row can
 * coexist with soft-deleted rows of the same name), each live or soft-deleted. */
export const arbFlagNameRows = fc.array(
  fc.record({ name: arbFlagName, deletedAt: arbNullableInstant }),
  { maxLength: 12 },
);

/** A declared catalog: distinct names from the same pool. */
export const arbDeclaredNames = fc.uniqueArray(arbFlagName, { maxLength: 5 });
