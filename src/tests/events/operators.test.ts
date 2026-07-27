import { describe, expect, it } from 'vitest';
import { type Delay, throttle } from '../../events/operators.js';
import type { Clock } from '../../foundation/clock.js';

// The laws of the throttle SHELL. `rate.prop.test.ts` already hammers the policy
// (`planEmit`) with hundreds of arbitrary instant sequences; what cannot be seen
// from there is everything the async generator adds on top — which value survives
// a suppression window, whether a held value escapes at end of stream, and
// whether walking away tears the upstream iterator down. Those are the four
// things a subscriber actually feels, so they get explicit tests here.
//
// TIME IS A FICTION IN THIS FILE. Nothing sleeps for real: the `Delay` port is
// bound to a fake whose `sleep(ms)` moves a mutable clock forward by `ms` and
// resolves on the next macrotask, so a "100ms window" costs zero wall time and
// the same assertions hold on a loaded CI box. This is the stream analogue of
// `fixedClock`, and the reason `Delay` exists as a seam at all (CONVENTIONS §10
// rule 3, "never `vi.useFakeTimers`" — a process-global fake timer would not
// help here anyway, because the operator's decisions read the injected `Clock`).
//
// WHY THE FAKE SLEEP RESOLVES ON A MACROTASK, not synchronously. The operator's
// core move is `Promise.race([pull(), timer])`, and a test is only worth writing
// if it knows which side wins. Microtasks always drain before the next macrotask,
// so the rule this file relies on is a hard one, not a margin:
//
//   a value the source already has ALWAYS beats a pending timer,
//   and the timer only fires once the source has nothing ready.
//
// That is exactly the real-world semantics being modelled — a `setTimeout` cannot
// jump the queue ahead of data sitting in a socket buffer — so the two source
// shapes below (`readySource`, values available now; `pacedSource`, values that
// cost clock time) let each law pick the side of the race it needs.

const T0 = new Date('2026-06-15T00:00:00.000Z');
const INTERVAL_MS = 100;

// --- test doubles ----------------------------------------------------------

interface TestClock extends Clock {
  /** Jump to `instant`, ignoring the request if it would run backwards. */
  advanceTo(instant: Date): void;
}

/**
 * A clock that can be moved. `fixedClock` is deliberately frozen, which is right
 * for a use-case that reads `now` once — but a throttle reads it on every turn
 * and would spin forever against a clock that never advances.
 */
function advanceableClock(start: Date): TestClock {
  let current = start;
  return {
    now: () => current,
    advanceTo: (instant) => {
      if (instant.getTime() > current.getTime()) current = instant;
    },
  };
}

interface TestDelay extends Delay {
  /** Every duration the operator asked to sleep, in call order. */
  readonly slept: readonly number[];
  /** Resolves the first time the operator sleeps — i.e. the first suppression. */
  readonly firstSuppression: Promise<void>;
}

/**
 * Virtual time. The deadline is computed when `sleep` is CALLED and applied when
 * it fires, so two overlapping sleeps (the operator's window and a source's own
 * pacing) do not each add their duration to the clock — they land on the later
 * of the two deadlines, the way real concurrent timers do.
 */
function virtualDelay(clock: TestClock): TestDelay {
  const slept: number[] = [];
  let announceFirstSleep: (() => void) | undefined;
  const firstSuppression = new Promise<void>((resolve) => {
    announceFirstSleep = resolve;
  });
  return {
    slept,
    firstSuppression,
    sleep: (ms) => {
      slept.push(ms);
      const deadline = new Date(clock.now().getTime() + ms);
      announceFirstSleep?.();
      return new Promise((resolve) => {
        setImmediate(() => {
          clock.advanceTo(deadline);
          resolve();
        });
      });
    },
  };
}

interface SpySource<T> {
  /** The stream handed to the operator. */
  readonly iterable: AsyncIterable<T>;
  /** How many times the operator cancelled us through `iterator.return()`. */
  returned: number;
}

/**
 * A source whose values are ALREADY available (pre-resolved promises), so it wins
 * every race against a pending timer — the shape that puts the operator under a
 * burst. `tail` decides what happens after the last value: `complete` reports
 * done, `stall` never settles again, which models a live subscription that has
 * simply gone quiet and lets a test observe a window closing rather than a
 * stream ending.
 *
 * `return()` is the spy: the whole point of the cancellation law is that the
 * operator calls it.
 */
function readySource<T>(items: readonly T[], tail: 'complete' | 'stall' = 'complete'): SpySource<T> {
  const queue = items.map((value) => ({ value }));
  const source: SpySource<T> = {
    returned: 0,
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
        next: (): Promise<IteratorResult<T>> => {
          const head = queue.shift();
          if (head !== undefined) return Promise.resolve({ value: head.value, done: false });
          if (tail === 'stall') return new Promise<IteratorResult<T>>(() => undefined);
          return Promise.resolve({ value: undefined, done: true });
        },
        return: (): Promise<IteratorResult<T>> => {
          source.returned += 1;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    },
  };
  return source;
}

/**
 * A source that costs `gapMs` of clock time per value, using the same virtual
 * delay — a producer ticking along faster than the throttle window. Because it
 * only produces when pulled, this is also the shape that shows the operator's
 * backpressure: an `AsyncIterable` source is never running ahead of its reader.
 */
async function* pacedSource<T>(
  items: readonly T[],
  gapMs: number,
  delay: Delay,
): AsyncGenerator<T> {
  for (const value of items) {
    // eslint-disable-next-line no-await-in-loop -- pacing IS the point of this fake
    await delay.sleep(gapMs);
    yield value;
  }
}

interface Emission<T> {
  readonly value: T;
  /** Clock offset from `T0`, in ms, at the moment the operator let this value out. */
  readonly at: number;
}

/**
 * Reads up to `limit` values, stamping each with the instant the operator chose
 * to release it — the emission TIMELINE is what every law below is about, so it
 * has to be captured as the stream runs rather than reconstructed afterwards.
 * Stopping at `limit` is a `break`, which is also how a real subscriber leaves.
 */
async function collect<T>(
  stream: AsyncIterable<T>,
  clock: Clock,
  limit: number,
): Promise<Array<Emission<T>>> {
  const emissions: Array<Emission<T>> = [];
  for await (const value of stream) {
    emissions.push({ value, at: clock.now().getTime() - T0.getTime() });
    if (emissions.length >= limit) break;
  }
  return emissions;
}

describe('throttle', () => {
  // --- Law 1: the leading edge --------------------------------------------
  // A throttle delays REPEATS. Making the first event wait would add latency to
  // the one delivery a subscriber is most likely to be watching for, and would
  // make "subscribe" feel broken on an idle topic.

  it('passes the first value through with no delay at all', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    // `stall` so nothing can complete the stream for us: the value that comes out
    // does so on the leading edge or not at all.
    const source = readySource(['first'], 'stall');

    const emissions = await collect(
      throttle<string>(INTERVAL_MS, clock, delay)(source.iterable),
      clock,
      1,
    );

    expect(emissions).toEqual([{ value: 'first', at: 0 }]);
    // The strong half of the law: the clock did not move because the operator
    // never even considered sleeping.
    expect(delay.slept).toEqual([]);
  });

  // --- Law 2: coalescing keeps the NEWEST ----------------------------------
  // While the window is shut, the operator holds exactly one value and lets each
  // new arrival replace it. Keeping the newest is what makes the drop lossless:
  // a payload carries ids only and the resolver re-fetches, so the survivor
  // describes the same current state that all five arrivals described (the five
  // laws, CONVENTIONS §11). Keeping the OLDEST instead would still emit "one per
  // window" and still look fine on a count — and would show subscribers a state
  // that is four events out of date.

  it('emits one value immediately, then the LAST of the burst when the window closes', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['v1', 'v2', 'v3', 'v4', 'v5'], 'stall');

    const emissions = await collect(
      throttle<string>(INTERVAL_MS, clock, delay)(source.iterable),
      clock,
      2,
    );

    // v2, v3 and v4 are gone — superseded, not queued. And the survivor is v5.
    expect(emissions).toEqual([
      { value: 'v1', at: 0 },
      { value: 'v5', at: INTERVAL_MS },
    ]);
    // ONE timer for the whole burst, not one per suppressed value. A timer per
    // value would still emit v5 here, but would leave four pending timers behind
    // per window — a slow leak under exactly the load this operator exists for.
    expect(delay.slept).toEqual([INTERVAL_MS]);
  });

  // --- Law 3: the trailing edge --------------------------------------------
  // The one place the interval is deliberately not honored. If the source ends
  // while a value is held, dropping it would leave the subscriber parked on a
  // state that the server knows is stale, with nothing ever coming to correct
  // it. Better a too-early final emission than a permanently wrong screen.

  it('flushes a suppressed value when the source completes, without waiting out the window', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['a', 'b', 'c'], 'complete');

    // A limit above the value count, so the loop ends because the STREAM ended.
    const emissions = await collect(
      throttle<string>(INTERVAL_MS, clock, delay)(source.iterable),
      clock,
      10,
    );

    // `at: 0` for 'c' is the whole law: it came out while the window was still
    // shut. Were it the window closing rather than the trailing edge, the fake
    // delay would have moved the clock to 100 first.
    expect(emissions).toEqual([
      { value: 'a', at: 0 },
      { value: 'c', at: 0 },
    ]);
    // The window was genuinely open — the operator had armed a timer and then
    // abandoned it, rather than never having suppressed anything.
    expect(delay.slept).toEqual([INTERVAL_MS]);
  });

  // --- Law 4: the rate ceiling ---------------------------------------------
  // The reason the operator exists, stated over the wall clock rather than over
  // `planEmit`'s inputs: however fast the producer ticks, two consecutive
  // deliveries to this subscriber are never closer than the configured interval.

  it('never emits two values closer together than minIntervalMs', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const gapMs = 10; // the producer is ten times faster than the ceiling allows
    const values = Array.from({ length: 40 }, (_, index) => index);

    const emissions = await collect(
      throttle<number>(INTERVAL_MS, clock, delay)(pacedSource(values, gapMs, delay)),
      clock,
      4,
    );

    expect(emissions).toHaveLength(4);
    for (let i = 1; i < emissions.length; i++) {
      const previous = emissions[i - 1]!;
      const current = emissions[i]!;
      expect(current.at - previous.at).toBeGreaterThanOrEqual(INTERVAL_MS);
    }
    // Un-throttled, four values off a 10ms producer would all be out by t+40.
    expect(emissions[3]!.at).toBeGreaterThanOrEqual(3 * INTERVAL_MS);
    // Backpressure, which is the other half of choosing `AsyncIterable` over an
    // `Observable`: a pull-based producer is SLOWED by a slow subscriber, not
    // sampled. So nothing is skipped here — `0,1,2,3` and not `0,1,3,5`. This
    // only holds because the operator holds its in-flight `next()` across loop
    // turns; a fresh pull each turn would abandon whichever one lost the race to
    // the timer, and the value it was carrying with it.
    expect(emissions.map((emission) => emission.value)).toEqual([0, 1, 2, 3]);
  });

  // --- Law 5: inactive ------------------------------------------------------
  // `minIntervalMs: 0` must be the SAME code path as no throttle at all, not a
  // second implementation that can drift. The bus skips this wrapper entirely
  // when no rate is configured, so this pins the operator's own behaviour: were
  // the two ever to disagree, "rate 0" and "rate absent" would mean different
  // things depending on which door a subscription came through.

  it('passes every value through untouched when minIntervalMs is 0', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['a', 'b', 'c', 'd', 'e'], 'complete');

    const emissions = await collect(throttle<string>(0, clock, delay)(source.iterable), clock, 10);

    expect(emissions).toEqual([
      { value: 'a', at: 0 },
      { value: 'b', at: 0 },
      { value: 'c', at: 0 },
      { value: 'd', at: 0 },
      { value: 'e', at: 0 },
    ]);
    // Nothing was ever held, so nothing was ever slept on.
    expect(delay.slept).toEqual([]);
  });

  // --- Law 6: cancellation propagates --------------------------------------
  // The leak-freedom law, and the one with real operational teeth: upstream of
  // this operator is a Repeater subscribed to the event target (Redis in
  // production). If the operator swallows the consumer's exit, that subscription
  // survives its socket — one orphan per disconnect, forever. The operator's
  // `finally` is the only thing standing between a mobile client dropping off a
  // train and a slow memory leak on the server.

  it('returns the upstream iterator when the consumer breaks out', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['a', 'b', 'c'], 'stall');

    let seen: string | undefined;
    for await (const value of throttle<string>(INTERVAL_MS, clock, delay)(source.iterable)) {
      seen = value;
      break;
    }

    expect(seen).toBe('a');
    expect(delay.slept).toEqual([]); // left on the leading edge, before any window
    expect(source.returned).toBe(1);
  });

  it('returns the upstream iterator even when cancelled mid-suppression', async () => {
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['a', 'b'], 'stall');
    const iterator = throttle<string>(INTERVAL_MS, clock, delay)(source.iterable)[
      Symbol.asyncIterator
    ]();

    expect((await iterator.next()).value).toBe('a'); // leading edge

    // Ask for one more WITHOUT awaiting it: the operator pulls 'b', finds the
    // window shut, holds it and parks on the timer. `firstSuppression` resolves
    // inside `sleep`, so when the test resumes the operator is provably in the
    // race — a value held, a timer pending, nothing about to complete.
    const held = iterator.next();
    await delay.firstSuppression;
    expect(delay.slept).toEqual([INTERVAL_MS]);
    expect(source.returned).toBe(0);

    // Now the socket closes. This is the hard case: the generator is suspended
    // inside an `await`, so the return request has to survive being queued
    // behind the in-flight pull instead of being answered straight away.
    const finish = iterator.return?.bind(iterator);
    if (finish === undefined) {
      throw new Error('the throttled stream must expose return() — cancellation depends on it');
    }
    const cancelled = finish();

    // The held value is not stranded by the cancellation; it is released as the
    // window closes, and only then does the teardown run.
    expect((await held).value).toBe('b');
    await cancelled;
    expect(source.returned).toBe(1);
  });

  it('propagates cancellation while parked on a QUIET upstream (regression)', async () => {
    // The resting state of a real subscription: one value delivered, then
    // nothing on that topic for a while. No value is held, so no timer is
    // armed, and the operator sits inside `await pull()`.
    //
    // This is the shape that leaked. The teardown used to live in the pump's
    // `finally`, but calling `return()` on an async generator suspended at an
    // `await` only QUEUES the request — with a silent upstream it would never be
    // processed, so the pubsub Repeater underneath (and, with the Redis target,
    // its channel subscription) stayed alive for the life of the process.
    // graphql-ws calls `return()` on socket close, so every throttled subscriber
    // that disconnected during a lull leaked one listener.
    const clock = advanceableClock(T0);
    const delay = virtualDelay(clock);
    const source = readySource(['only'], 'stall');
    const stream = throttle<string>(INTERVAL_MS, clock, delay)(source.iterable);

    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'only', done: false });

    // Park the operator on a pull that will never settle, then cancel.
    void iterator.next();
    await Promise.resolve();

    // The fix returns the UPSTREAM first, which is what settles that pull — so
    // this resolves instead of hanging. A 1s race makes the failure a readable
    // assertion rather than a suite timeout.
    const outcome = await Promise.race([
      iterator.return?.().then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);

    expect(outcome).toBe('closed');
    expect(source.returned).toBe(1);
  });
});
