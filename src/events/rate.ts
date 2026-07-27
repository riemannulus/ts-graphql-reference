/**
 * Throttle POLICY — pure. This is the `locks.ts` ↔ `uow.ts` split applied to
 * stream operators: `operators.ts` owns the async generator that sleeps, reads
 * the injected clock, and drops superseded events, and THIS file owns the single
 * decision it sleeps on. Nothing here awaits, and nothing here reads a clock —
 * `now` arrives as a PARAMETER, the same contract every core file signs
 * (CONVENTIONS §10) and the reason oxlint's repo-wide ban on the `Date` global
 * costs this module nothing. It imports NOTHING.
 *
 * The split is not decoration. Written as one async generator, "at most one
 * emission per interval" would be provable only by a timing test — slow, flaky,
 * and blind to the boundaries. Pulled out as `planEmit(state, now, interval)`,
 * the rate ceiling becomes a LAW a property test can hammer with hundreds of
 * arbitrary instant sequences and no clock at all (see
 * `src/tests/events/rate.prop.test.ts`), which is the one thing this codebase is
 * best at (CONVENTIONS §6).
 *
 * The vocabulary is deliberately `emit` / `defer`, never `drop`. Whether a
 * suppressed event is discarded, coalesced, or replaced by a newer one is the
 * SHELL's business — it keeps only the most recent, which is lossless because a
 * payload carries ids only and the resolver re-fetches (the five laws, law 1).
 * The policy answers exactly one question: may this stream emit at `now`, and if
 * not, how long until it may.
 *
 * How to extend: a different rate shape (a token bucket, a per-key budget) is a
 * new state type + a new `plan…` function beside these — the shell picks which
 * policy to drive. What does NOT change is the contract: total, clock-free,
 * `now` as data, and a decision that carries the state its caller should adopt
 * rather than mutating anything.
 */

/**
 * Everything the throttle remembers between events: the instant it last let one
 * through, or `null` before the first. One field is genuinely all of it —
 * "suppressed events pending" is the shell's buffer, not policy state, so the
 * policy stays a function of `(state, now, interval)` and nothing else.
 */
export interface ThrottleState {
  readonly lastEmittedAt: Date | null;
}

/**
 * What the shell must do with the event it is holding. `emit` carries the
 * `next` state to adopt — the caller never derives it, so "the anchor is the
 * emitted instant" is stated in exactly ONE place. `defer` carries a strictly
 * positive `waitMs`; sleeping that long and asking again with the SAME state is
 * guaranteed to emit (the wait-coherence law), which is what makes the shell's
 * loop terminate.
 */
export type EmitDecision =
  | { readonly kind: 'emit'; readonly next: ThrottleState }
  | { readonly kind: 'defer'; readonly waitMs: number };

/** The state a stream starts in: nothing emitted yet, so the first event leads. */
export const initialThrottleState: ThrottleState = { lastEmittedAt: null };

/**
 * Decides whether a stream may emit at `now`. TOTAL — defined for every value of
 * its input types, including a non-finite or negative `minIntervalMs` and an
 * Invalid Date, so a property test can throw arbitrary inputs at it
 * (CONVENTIONS §3). It never throws.
 *
 * The rules, in order:
 *   - `minIntervalMs <= 0` — the operator is INACTIVE and every event emits.
 *     Same code path as an active throttle, so "no rate configured" is not a
 *     second implementation that can drift.
 *   - no `lastEmittedAt` — the LEADING edge emits. A throttle delays repeats,
 *     never the first event.
 *   - `elapsed >= minIntervalMs` — emit, re-anchoring on `now`.
 *   - otherwise defer for `minIntervalMs - elapsed`, which is `> 0` by
 *     construction (both operands finite, `elapsed` strictly smaller).
 *
 * Two DEFENSIVE CLAMPS keep it total, and both fail OPEN — toward emitting:
 *   1. A non-finite `minIntervalMs` (`NaN`, `±Infinity`) is read as 0, i.e.
 *      inactive. `Infinity` would otherwise mean "defer forever", and a
 *      subscription that never emits again is a far worse failure than an
 *      unthrottled one. This is the opposite of a feature flag's safe default
 *      (`false`, fail CLOSED) for exactly that reason: here the closed position
 *      is the harmful one.
 *   2. A non-finite `elapsed` — which is what an Invalid Date on either side
 *      produces — emits rather than deferring on a `NaN` wait.
 *
 * A BACKWARDS clock (`now` before `lastEmittedAt`, e.g. an NTP step) is not
 * clamped: `elapsed` is negative, so the wait grows beyond `minIntervalMs`. The
 * stored anchor is treated as authoritative because the rate ceiling is the
 * invariant this function exists to hold, and wait coherence survives it —
 * asking again at `now + waitMs` lands exactly on `elapsed === minIntervalMs`.
 */
export function planEmit(state: ThrottleState, now: Date, minIntervalMs: number): EmitDecision {
  const emit: EmitDecision = { kind: 'emit', next: { lastEmittedAt: now } };
  const interval = Number.isFinite(minIntervalMs) ? minIntervalMs : 0;
  if (interval <= 0) return emit;
  const { lastEmittedAt } = state;
  if (lastEmittedAt === null) return emit;
  const elapsed = now.getTime() - lastEmittedAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed >= interval) return emit;
  return { kind: 'defer', waitMs: interval - elapsed };
}
