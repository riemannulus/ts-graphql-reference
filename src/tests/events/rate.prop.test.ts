import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import {
  type EmitDecision,
  initialThrottleState,
  planEmit,
  type ThrottleState,
} from '../../events/rate.js';

// The laws of the throttle policy. `planEmit` takes `now` as data and reads no
// clock, so every one of these runs against hundreds of random instant
// sequences with no timers, no sleeping, and no event bus — which is the entire
// reason the policy was split out of `operators.ts` (see `rate.ts`). The shell's
// own properties (trailing edge, cancellation) are timing behaviour and get
// explicit tests instead.
//
// Instants are built from a fixed epoch (deterministic given the fast-check
// seed) and kept INTEGRAL: `new Date(x)` truncates a fractional millisecond, so
// a fractional `waitMs` would break the wait-coherence law's arithmetic for
// reasons that have nothing to do with the policy. Law 1 is the exception — it
// exists to throw exotic values at the function.

const EPOCH = new Date('2026-06-15T00:00:00.000Z');
const EPOCH_MS = EPOCH.getTime();

const MAX_GAP_MS = 5_000;
const MAX_INTERVAL_MS = 5_000;

/** An instant within ~10s of the reference epoch. */
const arbInstant: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 2 * MAX_GAP_MS })
  .map((offset) => new Date(EPOCH_MS + offset));

/** A throttle state: never emitted, or anchored at some instant near the epoch. */
const arbState: fc.Arbitrary<ThrottleState> = fc
  .option(arbInstant, { nil: null })
  .map((lastEmittedAt) => ({ lastEmittedAt }));

/** A run: one interval plus the gaps between successive events. */
const arbRun = fc.record({
  minIntervalMs: fc.integer({ min: 0, max: MAX_INTERVAL_MS }),
  gaps: fc.array(fc.nat({ max: MAX_GAP_MS }), { maxLength: 24 }),
});

/** The same, with every gap at least as long as the interval (law 3's premise). */
const arbSpacedRun = fc.integer({ min: 0, max: MAX_INTERVAL_MS }).chain((minIntervalMs) =>
  fc.record({
    minIntervalMs: fc.constant(minIntervalMs),
    gaps: fc.array(fc.integer({ min: minIntervalMs, max: minIntervalMs + MAX_GAP_MS }), {
      maxLength: 24,
    }),
  }),
);

/** Gaps → the ascending sequence of instants they describe. */
const instantsFrom = (gaps: readonly number[]): Date[] => {
  let cursor = EPOCH_MS;
  return gaps.map((gap) => {
    cursor += gap;
    return new Date(cursor);
  });
};

/** Drives the policy over a sequence exactly as the shell would, from the initial state. */
const run = (
  instants: readonly Date[],
  minIntervalMs: number,
): { decisions: EmitDecision[]; emitted: Date[] } => {
  let state = initialThrottleState;
  const decisions: EmitDecision[] = [];
  const emitted: Date[] = [];
  for (const now of instants) {
    const decision = planEmit(state, now, minIntervalMs);
    decisions.push(decision);
    if (decision.kind === 'emit') {
      emitted.push(now);
      state = decision.next;
    }
  }
  return { decisions, emitted };
};

// --- Law 1: totality -------------------------------------------------------
// Anything the type allows: a negative, fractional, NaN or infinite interval,
// and an Invalid Date or an extreme one. A throw fails the property, so this
// pins "never throws" alongside the shape of what comes back.

const arbAnyNumber = fc.oneof(
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    0.5,
    Number.MIN_VALUE,
  ),
);

const arbAnyDate = fc.oneof(
  arbInstant,
  fc.constantFrom(new Date(Number.NaN), new Date(0), new Date(8.64e15), new Date(-8.64e15)),
);

const arbAnyState: fc.Arbitrary<ThrottleState> = fc
  .option(arbAnyDate, { nil: null })
  .map((lastEmittedAt) => ({ lastEmittedAt }));

test.prop([arbAnyState, arbAnyDate, arbAnyNumber])(
  'totality: any state, instant and interval yield emit or defer — never a throw',
  (state, now, minIntervalMs) => {
    const decision = planEmit(state, now, minIntervalMs);
    if (decision.kind === 'emit') {
      expect(decision.next.lastEmittedAt).toBe(now);
    } else {
      expect(decision.kind).toBe('defer');
      // A deferral the shell can actually sleep on: finite and strictly positive.
      expect(Number.isFinite(decision.waitMs)).toBe(true);
      expect(decision.waitMs).toBeGreaterThan(0);
    }
  },
);

// --- Law 2: the rate ceiling ----------------------------------------------
// The reason the operator exists. Whatever the arrival pattern, two consecutive
// emissions are never closer together than the configured interval.

test.prop([arbRun])(
  'rate ceiling: consecutive emitted instants are at least minIntervalMs apart',
  ({ minIntervalMs, gaps }) => {
    const { emitted } = run(instantsFrom(gaps), minIntervalMs);
    for (let i = 1; i < emitted.length; i++) {
      const previous = emitted[i - 1]!;
      const current = emitted[i]!;
      expect(current.getTime() - previous.getTime()).toBeGreaterThanOrEqual(minIntervalMs);
    }
  },
);

// --- Law 3: identity -------------------------------------------------------
// The other side of the ceiling: a throttle must not cost anything when the
// stream is already slower than the limit — no dropped events, no delay.

test.prop([arbSpacedRun])(
  'identity: a stream already spaced by minIntervalMs emits every single event',
  ({ minIntervalMs, gaps }) => {
    const instants = instantsFrom(gaps);
    const { decisions, emitted } = run(instants, minIntervalMs);
    expect(decisions.every((d) => d.kind === 'emit')).toBe(true);
    expect(emitted).toEqual(instants);
  },
);

// --- Law 4: wait coherence -------------------------------------------------
// What makes the shell's sleep-and-retry loop terminate: the deferral is not a
// hint, it is exactly long enough. Asking again at `now + waitMs` with the SAME
// state (nothing emitted in between) must emit.

test.prop([arbState, arbInstant, fc.integer({ min: 0, max: MAX_INTERVAL_MS })])(
  'wait coherence: re-asking at now + waitMs with the same state emits',
  (state, now, minIntervalMs) => {
    const decision = planEmit(state, now, minIntervalMs);
    if (decision.kind !== 'defer') return;
    expect(decision.waitMs).toBeGreaterThan(0);
    const later = new Date(now.getTime() + decision.waitMs);
    expect(planEmit(state, later, minIntervalMs).kind).toBe('emit');
  },
);

// --- Law 5: inactive -------------------------------------------------------
// `minIntervalMs: 0` (or absent, which the shell reads as 0) must be the same
// code path as an unthrottled subscription — every event through, anchored on
// its own instant. Instants here are NOT forced to ascend: inactivity does not
// depend on the arrival pattern at all.

test.prop([fc.array(arbAnyDate, { maxLength: 24 })])(
  'inactive: minIntervalMs 0 emits every event, whatever the instants',
  (instants) => {
    const { decisions, emitted } = run(instants, 0);
    expect(emitted).toEqual(instants);
    expect(decisions.every((d) => d.kind === 'emit')).toBe(true);
  },
);
