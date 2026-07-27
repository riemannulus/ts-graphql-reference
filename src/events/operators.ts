import type { Clock } from '../foundation/clock.js';
import { initialThrottleState, planEmit, type ThrottleState } from './rate.js';

/**
 * Stream operators — the SHELL over `rate.ts`'s pure policy, and the `uow.ts`
 * analogue for streams: `rate.ts` decides, this file executes.
 *
 * The split is forced by the same rules that shape every other decision in this
 * codebase. A throttle reads the clock and awaits, and CONVENTIONS §1 bans both
 * from a pure module (`await` never appears in a core; `new Date()` is I/O). So
 * the policy — "given the last emission and now, emit or wait how long?" — lives
 * in `rate.ts` as a total function over passed-in data, where property tests pin
 * its laws, and only the driving loop lives here.
 *
 * That split is also the whole argument for not reaching for RxJS. An Rx
 * `auditTime` would put this policy inside a library, where the repo's own
 * property tests cannot see it; here the interesting half is a pure function and
 * the test tooling is the `fixedClock` the repo already has. The other half of
 * the argument is backpressure: `AsyncIterable` is pull-based, so a subscriber on
 * a slow mobile socket throttles its own producer, while an `Observable` would
 * push regardless. See the design spec §3.1 for the re-evaluation triggers.
 *
 * ONLY rate limiting lives here, and deliberately so. "Should this event exist
 * at all" belongs to the publishing service, "who may see it" to the topic key
 * and the re-fetch `where`. Rate is the one concern that CANNOT be pushed to the
 * publisher, because it is a property of the SUBSCRIBER's tolerance — the
 * publisher does not know how many subscribers there are or how fast each reads.
 */

/**
 * The sleep seam. A second port beside `Clock` rather than a method on it,
 * because they are different capabilities: `Clock` MINTS an instant (and is
 * shared by every service), while this one SUSPENDS.
 *
 * It has to be injectable or the operator is untestable: a fixed clock never
 * advances, so `planEmit` would return the same `defer` forever and a test would
 * spin. A test injects a delay that resolves immediately and advances its clock
 * by the requested amount, which makes the whole throttle deterministic — the
 * stream analogue of `fixedClock` (CONVENTIONS §10 rule 3, "never
 * `vi.useFakeTimers`").
 */
export interface Delay {
  sleep(ms: number): Promise<void>;
}

/** Production binding: a real timer. */
export const systemDelay: Delay = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * Rate-limits a stream to at most one emission per `minIntervalMs`.
 *
 * Semantics, exactly:
 *
 * - **Leading edge.** The first value passes immediately.
 * - **Coalescing.** While suppressed, only the MOST RECENT value is kept; the
 *   ones it replaced are dropped. This is lossless *here* and nowhere else: a
 *   payload carries ids only and the resolver re-fetches current state, so two
 *   consecutive events for one key are interchangeable (the five laws,
 *   CONVENTIONS §11). An operator like this over row-carrying payloads would be
 *   silent data loss.
 * - **Trailing edge.** A suppressed value is never dropped at end of stream: if
 *   the source completes while one is held, it is emitted before completing.
 *   This is the ONE place the interval is not honored, and it is the right
 *   trade — the alternative is showing the subscriber a stale final state.
 * - **Cancellation.** When the consumer stops (the socket closed, the
 *   subscription ended), the `finally` returns the upstream iterator, so the
 *   Repeater underneath unsubscribes from the event target rather than leaking.
 *
 * `minIntervalMs <= 0` is handled by `planEmit` (always emit), but the bus skips
 * the wrapper entirely in that case so an unthrottled subscription pays nothing.
 */
export function throttle<T>(
  minIntervalMs: number,
  clock: Clock,
  delay: Delay = systemDelay,
): (source: AsyncIterable<T>) => AsyncIterable<T> {
  return (source: AsyncIterable<T>): AsyncIterable<T> => {
    const upstream = source[Symbol.asyncIterator]();
    /**
     * Releases the upstream exactly once. Both teardown paths funnel through it
     * — `close` below and the pump's own `finally` — so whichever gets there
     * first wins and the source sees a single `return()`. The protocol tolerates
     * a second call, but a shared latch keeps the contract honest and is one
     * less thing for a source implementation to have to be careful about.
     */
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await upstream.return?.();
    };

    const pump = createPump(upstream, minIntervalMs, clock, delay, release);
    let closed = false;

    /**
     * Tear down, eagerly.
     *
     * This CANNOT be left to the pump's `finally`, and that is the subtle part.
     * `pump` is an async generator, and calling `return()` on one that is
     * suspended at an `await` does not unwind it — the request is QUEUED until
     * the generator next reaches a yield. The resting state of a live
     * subscription is exactly that suspension: parked on a pull from a topic
     * that is quiet. So a subscriber that disconnects during a lull would leave
     * the pump waiting forever, its `finally` unreached, and the pubsub
     * Repeater underneath still subscribed — a listener (and, on the Redis
     * target, a live channel) leaked for the life of the process.
     *
     * Returning the UPSTREAM first fixes it at the root: that settles the pull
     * the pump is parked on, so the pump then unwinds on its own.
     */
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await release();
      // Best-effort, and deliberately not awaited: the upstream is already
      // released, so nothing leaks if the pump takes its time (or, for a
      // misbehaving source that ignores `return`, never finishes at all).
      void Promise.resolve(pump.return(undefined)).catch(() => undefined);
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: () => pump.next(),
          async return(): Promise<IteratorResult<T>> {
            await close();
            return { done: true, value: undefined };
          },
          async throw(error: unknown): Promise<IteratorResult<T>> {
            await close();
            throw error;
          },
        };
      },
    };
  };
}

/**
 * The driving loop. Separated from `throttle` only so the wrapper above can own
 * `return()` — see the comment on `close`.
 */
function createPump<T>(
  iterator: AsyncIterator<T>,
  minIntervalMs: number,
  clock: Clock,
  delay: Delay,
  release: () => Promise<void>,
): AsyncGenerator<T, void, undefined> {
  return (async function* pump(): AsyncGenerator<T, void, undefined> {
    let state: ThrottleState = initialThrottleState;
    let pending: { readonly value: T } | null = null;
    // The in-flight `next()`, held across loop turns. Racing a fresh `next()`
    // against the timer on every turn would drop whichever pull lost the race.
    let inflight: Promise<IteratorResult<T>> | null = null;
    // One timer per suppression window, not one per value — a burst of suppressed
    // values must not pile up timers that all fire after the window closes.
    let timer: Promise<{ readonly kind: 'timer' }> | null = null;
    const pull = (): Promise<IteratorResult<T>> => (inflight ??= iterator.next());

    try {
      for (;;) {
        if (pending === null) {
          // eslint-disable-next-line no-await-in-loop -- a stream is sequential by definition
          const next = await pull();
          inflight = null;
          if (next.done === true) return;
          const decision = planEmit(state, clock.now(), minIntervalMs);
          if (decision.kind === 'emit') {
            state = decision.next;
            yield next.value;
          } else {
            pending = { value: next.value };
          }
          continue;
        }

        const decision = planEmit(state, clock.now(), minIntervalMs);
        if (decision.kind === 'emit') {
          state = decision.next;
          const { value } = pending;
          pending = null;
          timer = null;
          yield value;
          continue;
        }

        timer ??= delay.sleep(decision.waitMs).then(() => ({ kind: 'timer' as const }));
        // eslint-disable-next-line no-await-in-loop -- waiting out the window IS the operator
        const raced = await Promise.race([
          pull().then((result) => ({ kind: 'source' as const, result })),
          timer,
        ]);
        if (raced.kind === 'timer') {
          // The window closed; the next turn's `planEmit` will emit what is held.
          timer = null;
          continue;
        }
        inflight = null;
        if (raced.result.done === true) {
          yield pending.value; // trailing edge
          return;
        }
        pending = { value: raced.result.value }; // coalesce: newest wins
      }
    } finally {
      // Covers the paths the wrapper's `close` does not: normal completion, a
      // `break` while the pump sits at a yield, and a throw from the loop. The
      // latch in `release` makes this and `close` idempotent with each other.
      await release();
    }
  })();
}
