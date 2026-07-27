import type { TypedEventTarget } from '@graphql-yoga/typed-event-target';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../events/event-bus.js';
import { defineTopics, topic } from '../../events/events.js';
import type { Delay } from '../../events/operators.js';
import type { Clock } from '../../foundation/clock.js';
import { fixedClock } from '../support/clock.js';

/**
 * The event bus — the client binding — against a FIXTURE registry rather than the
 * shipped `TOPICS`, exactly as `flag-reader.test.ts` proves the flag facade
 * against fixture specs. The app ships ONE topic today, so testing through it
 * would leave "does routing actually separate two topics?" untested by
 * construction; a fixture registry makes the machinery answerable on its own and
 * keeps these laws standing when the real catalog grows.
 *
 * Nothing here touches Redis or the database. Omitting `eventTarget` gives Yoga's
 * in-process `EventTarget`, which is the same code path production runs with
 * `REDIS_URL` unset — the fan-out backend is injected, so the bus cannot tell the
 * difference. The clock and the sleep seam are injected too, so the whole file is
 * deterministic and runs in milliseconds with no fake timers.
 */

/**
 * Both key kinds, plus a SECOND number-keyed topic. `shadow` exists only so the
 * topic-isolation law has something to collide with: two topics sharing a key
 * value is the case that distinguishes real per-topic routing from a bus that
 * keys channels by the routing key alone.
 */
const FIXTURE_TOPICS = defineTopics({
  numeric: topic<number, { id: number }>('number', 'A number-keyed fixture topic.'),
  textual: topic<string, { id: string }>('string', 'A string-keyed fixture topic.'),
  shadow: topic<number, { id: number }>('number', 'A second number-keyed topic, same key space.'),
});

const EPOCH = new Date('2026-06-15T00:00:00.000Z');

/** A bus over the fixture registry on Yoga's own in-process target. */
const makeBus = () => createEventBus(FIXTURE_TOPICS, { clock: fixedClock(EPOCH) });

// --- Test machinery --------------------------------------------------------

/**
 * Yields to the macrotask queue, which drains every pending microtask on the
 * way. Every step these tests wait on — a Repeater resolving a pull, a
 * generator resuming past a `yield` — is microtask-driven, so one hop is a
 * complete quiescence point and NOT a sleep-and-hope. No fake timers are
 * involved (CONVENTIONS §10 rule 3); the only clock the bus reads is injected.
 */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

interface Consumer<T> {
  /** The first `count` values, or fewer if the stream ended (see `stop`). */
  readonly values: Promise<T[]>;
  /**
   * Cancels the subscription; `values` then settles with whatever arrived.
   *
   * CAUTION on a THROTTLED stream: `return()` on an async generator parked in an
   * `await` is queued behind that await, so cancelling a throttled subscription
   * whose upstream is idle never settles. Await it only where the generator is
   * parked at a `yield` — i.e. after `values` has resolved. (That is a property
   * of the operator, not of this helper; see the notes on `throttle`.)
   */
  stop(): Promise<void>;
}

/**
 * Starts consuming NOW and promises the next `count` values.
 *
 * This is not a convenience — it is the only correct way to observe this bus.
 * `pubsub.subscribe` hands back a Repeater whose event listener is attached by
 * the FIRST `next()` call, so a test that publishes before pulling is asserting
 * against a stream that was never listening, and would "pass" against a bus that
 * delivers nothing at all. Calling this, then `await tick()`, then publishing is
 * the order that makes the assertions mean something.
 *
 * `stop()` is how silence is proven: cancel, and `values` resolves with exactly
 * what had arrived — no timeout, no flake.
 */
function consume<T>(stream: AsyncIterable<T>, count: number): Consumer<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const values = (async () => {
    const received: T[] = [];
    while (received.length < count) {
      // eslint-disable-next-line no-await-in-loop -- a stream is sequential by definition
      const result = await iterator.next();
      if (result.done === true) break;
      received.push(result.value);
    }
    return received;
  })();
  return {
    values,
    async stop() {
      await iterator.return?.();
      await values;
    },
  };
}

/**
 * A clock that moves only when the test says so. `fixedClock` is frozen by
 * design and cannot serve here: the throttle asks `planEmit` again after each
 * sleep, and against a clock that never advances it would defer forever. Pairing
 * this with `manualDelay` below makes "time passed" an explicit test statement
 * rather than a wall-clock race.
 */
function advanceableClock(start: Date): { clock: Clock; advance: (ms: number) => void } {
  let instant = start;
  return {
    clock: { now: () => instant },
    advance: (ms) => {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

interface ManualDelay {
  readonly delay: Delay;
  /** Every `sleep(ms)` ever requested, oldest first — timers ASKED FOR, not fired. */
  readonly asked: () => number[];
  /** Wakes every outstanding sleep. */
  readonly release: () => void;
}

/**
 * The sleep seam, under test control. Nothing resolves until `release()`, which
 * is what makes the coalescing test deterministic: while the timer is held, the
 * only thing that can win the operator's internal race is a newly published
 * event, so "newest wins" is observed rather than raced for.
 */
function manualDelay(): ManualDelay {
  const asked: number[] = [];
  let waiting: Array<() => void> = [];
  return {
    delay: {
      sleep(ms) {
        asked.push(ms);
        return new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      },
    },
    asked: () => [...asked],
    release: () => {
      const woken = waiting;
      waiting = [];
      for (const wake of woken) wake();
    },
  };
}

/**
 * A real in-process `EventTarget` that also counts LIVE listeners.
 *
 * It is the smallest possible stand-in for the Redis target — the seam exists so
 * the bus never learns which backend it has — and it makes the one thing a
 * "nothing arrived" assertion cannot see observable: whether a cancelled
 * subscription actually detached, or merely stopped being read.
 */
function countingTarget(): { target: TypedEventTarget<CustomEvent>; listeners: () => number } {
  const inner = new EventTarget();
  let live = 0;
  const target = {
    addEventListener(type: string, callback: EventListener | null, options?: unknown) {
      live += 1;
      inner.addEventListener(type, callback, options as AddEventListenerOptions | undefined);
    },
    removeEventListener(type: string, callback: EventListener | null, options?: unknown) {
      live -= 1;
      inner.removeEventListener(type, callback, options as EventListenerOptions | undefined);
    },
    dispatchEvent: (event: Event) => inner.dispatchEvent(event),
  };
  return { target: target as unknown as TypedEventTarget<CustomEvent>, listeners: () => live };
}

/**
 * The bus as the OUTBOX DRAINER sees it: a topic name that arrived as TEXT out of
 * a database column, not as a literal. The typed surface makes an unregistered
 * name a compile error, so erasing the types is the only way to reach the runtime
 * guard at all — which is precisely the boundary the guard exists for.
 */
interface UntypedPublish {
  publish(topic: string, key: string | number, payload: unknown): void;
}
const asDrainer = (bus: object): UntypedPublish => bus as unknown as UntypedPublish;

// --- Law 1: round trip -----------------------------------------------------

describe('round trip', () => {
  it('delivers a payload published to the key a subscriber is listening on', async () => {
    const bus = makeBus();
    const consumer = consume(bus.subscribe('numeric', 7), 1);
    await tick();

    bus.publish('numeric', 7, { id: 7 });

    expect(await consumer.values).toEqual([{ id: 7 }]);
    await consumer.stop();
  });

  it('routes string keys the same way it routes number keys', async () => {
    // Both `KeyKind`s go through one channel-naming scheme, so this is the check
    // that a topic declared `'string'` is not quietly a second code path.
    const bus = makeBus();
    const consumer = consume(bus.subscribe('textual', 'user-1'), 1);
    await tick();

    bus.publish('textual', 'user-1', { id: 'user-1' });

    expect(await consumer.values).toEqual([{ id: 'user-1' }]);
    await consumer.stop();
  });

  it('preserves publication order for a single key', async () => {
    // The Repeater queues what a consumer has not pulled yet, so a subscriber on
    // a slow socket falls behind rather than losing the middle of a burst. That
    // is also why the throttle below has to be OPT-IN: unthrottled means every
    // event, in order.
    const bus = makeBus();
    const consumer = consume(bus.subscribe('numeric', 1), 3);
    await tick();

    bus.publish('numeric', 1, { id: 1 });
    bus.publish('numeric', 1, { id: 2 });
    bus.publish('numeric', 1, { id: 3 });

    expect(await consumer.values).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await consumer.stop();
  });

  it('fans one publication out to every subscriber on that key', async () => {
    // Subscribers observe, they do not consume: a second listener must not steal
    // the first one's event. Two browser tabs on one account is the everyday case.
    const bus = makeBus();
    const first = consume(bus.subscribe('numeric', 3), 1);
    const second = consume(bus.subscribe('numeric', 3), 1);
    await tick();

    bus.publish('numeric', 3, { id: 3 });

    expect(await first.values).toEqual([{ id: 3 }]);
    expect(await second.values).toEqual([{ id: 3 }]);
    await first.stop();
    await second.stop();
  });
});

// --- Law 2: key isolation --------------------------------------------------

describe('key isolation', () => {
  // THE law that makes a per-user subscription safe. The topic key IS the
  // authorization filter's first half (`event-registry.ts`: "routing IS the
  // authorization filter"), so if a subscriber on key A can see key B's events,
  // one user is watching another user's account and no `where` clause downstream
  // can undo it.

  it('never delivers another key’s event first', async () => {
    const bus = makeBus();
    const mine = consume(bus.subscribe('numeric', 1), 1);
    await tick();

    // Someone else's event goes out FIRST. If routing leaked, the very next
    // value this subscriber sees would be theirs — the ordering is what turns
    // "we saw ours eventually" into proof.
    bus.publish('numeric', 2, { id: 2 });
    bus.publish('numeric', 1, { id: 1 });

    expect(await mine.values).toEqual([{ id: 1 }]);
    await mine.stop();
  });

  it('stays completely silent while only other keys publish', async () => {
    const bus = makeBus();
    const mine = consume(bus.subscribe('numeric', 1), 1);
    await tick();

    bus.publish('numeric', 2, { id: 2 });
    bus.publish('numeric', 3, { id: 3 });
    await tick();

    // Cancelling settles the stream, so "nothing arrived" is an assertion on a
    // resolved value rather than an expired timeout.
    await mine.stop();
    expect(await mine.values).toEqual([]);
  });

  it('separates string keys too, including a key that is a prefix of another', async () => {
    // String keys are concatenated into the channel name, so neighbouring keys
    // are the case worth pinning: `user-1` must not receive `user-10`'s events.
    const bus = makeBus();
    const mine = consume(bus.subscribe('textual', 'user-1'), 1);
    await tick();

    bus.publish('textual', 'user-10', { id: 'user-10' });
    bus.publish('textual', 'user-1', { id: 'user-1' });

    expect(await mine.values).toEqual([{ id: 'user-1' }]);
    await mine.stop();
  });
});

// --- Law 3: topic isolation ------------------------------------------------

describe('topic isolation', () => {
  it('never delivers another topic’s event, even on the same key value', async () => {
    // Key 5 exists in both `numeric` and `shadow`. A bus that routed by key alone
    // would pass every other test in this file and fail only here.
    const bus = makeBus();
    const consumer = consume(bus.subscribe('numeric', 5), 1);
    await tick();

    bus.publish('shadow', 5, { id: 500 });
    bus.publish('numeric', 5, { id: 5 });

    expect(await consumer.values).toEqual([{ id: 5 }]);
    await consumer.stop();
  });

  it('stays silent while only the other topic publishes on that key', async () => {
    const bus = makeBus();
    const consumer = consume(bus.subscribe('numeric', 5), 1);
    await tick();

    bus.publish('shadow', 5, { id: 500 });
    await tick();

    await consumer.stop();
    expect(await consumer.values).toEqual([]);
  });
});

// --- The injected fan-out backend ------------------------------------------

describe('eventTarget injection', () => {
  it('publishes through the target it was given, so two buses on one target meet', async () => {
    // The multi-instance case in miniature, with no Redis: the bus never builds
    // its own backend, so a target shared by two buses is the whole distributed
    // story. If `deps.eventTarget` were dropped on the floor, each bus would get
    // a private `EventTarget` and this would receive nothing.
    const shared: TypedEventTarget<CustomEvent> = new EventTarget();
    const clock = fixedClock(EPOCH);
    const publisher = createEventBus(FIXTURE_TOPICS, { clock, eventTarget: shared });
    const subscriber = createEventBus(FIXTURE_TOPICS, { clock, eventTarget: shared });

    const consumer = consume(subscriber.subscribe('numeric', 9), 1);
    await tick();

    publisher.publish('numeric', 9, { id: 9 });

    expect(await consumer.values).toEqual([{ id: 9 }]);
    await consumer.stop();
  });

  it('gives each bus a private target when none is injected', async () => {
    // The other half: the in-process fallback must be per-bus, not a module-level
    // singleton. A shared default would make test files leak into one another and
    // would silently "work" in the test above for the wrong reason.
    const first = makeBus();
    const second = makeBus();
    const consumer = consume(second.subscribe('numeric', 9), 1);
    await tick();

    first.publish('numeric', 9, { id: 9 });
    await tick();

    await consumer.stop();
    expect(await consumer.values).toEqual([]);
  });
});

// --- Law 4: unknown topics are rejected ------------------------------------

describe('unknown topic', () => {
  // Reachable only from the outbox drain path, which publishes a topic name it
  // read out of a TEXT column. The guard is where a corrupted row fails loudly
  // instead of fanning out to a channel nobody listens on — the same call this
  // repo makes for `UnparsableTopicKeyError`.

  it('throws on a topic name that is not in the registry', () => {
    expect(() => {
      asDrainer(makeBus()).publish('ghostTopic', 1, { id: 1 });
    }).toThrow(/Unknown event topic: "ghostTopic"/);
  });

  it('throws on an inherited Object.prototype name', () => {
    // `Object.hasOwn`, not `key in topics`: `'toString'` is on every object's
    // prototype chain, so an `in` check would wave a corrupted row straight
    // through into a dispatch on a channel called `toString:1`.
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(() => {
        asDrainer(makeBus()).publish(inherited, 1, { id: 1 });
      }).toThrow(/Unknown event topic/);
    }
  });

  it('does not throw for a registered topic nobody is listening on', () => {
    // Fire-and-forget (delivery rung 0) means zero subscribers is a normal
    // outcome, not an error — otherwise every service call would throw whenever
    // the user happened to have no open socket.
    expect(() => {
      makeBus().publish('numeric', 404, { id: 404 });
    }).not.toThrow();
  });
});

// --- Law 5: minIntervalMs --------------------------------------------------

describe('minIntervalMs', () => {
  it('coalesces a burst to the newest value and emits it when the window closes', async () => {
    const { clock, advance } = advanceableClock(EPOCH);
    const { delay, asked, release } = manualDelay();
    const bus = createEventBus(FIXTURE_TOPICS, { clock, delay });

    const consumer = consume(bus.subscribe('numeric', 1, { minIntervalMs: 50 }), 2);
    await tick();

    bus.publish('numeric', 1, { id: 1 }); // leading edge — a throttle never delays the first
    await tick();

    bus.publish('numeric', 1, { id: 2 }); // held: inside the window
    bus.publish('numeric', 1, { id: 3 }); // supersedes 2 — newest wins
    await tick();

    // ONE timer for the suppression window, not one per suppressed value: a
    // burst that piled up timers would fire them all after the window closed and
    // spin the loop once per dropped event.
    expect(asked()).toEqual([50]);

    advance(50);
    release();

    // `{ id: 2 }` is absent, and that is the point. Coalescing is lossless HERE
    // and nowhere else, because a payload carries ids only and the resolver
    // re-fetches current state — two consecutive events for one key are
    // interchangeable (the five laws, law 1).
    expect(await consumer.values).toEqual([{ id: 1 }, { id: 3 }]);
    await consumer.stop();
  });

  it('does not throttle when the option is omitted', async () => {
    // The contrast that keeps the test above honest: the same burst, the same
    // fakes, no option — every event through and the sleep seam never touched,
    // because the bus skips the wrapper entirely rather than building an
    // operator that happens to pass everything.
    const { clock } = advanceableClock(EPOCH);
    const { delay, asked } = manualDelay();
    const bus = createEventBus(FIXTURE_TOPICS, { clock, delay });

    const consumer = consume(bus.subscribe('numeric', 1), 3);
    await tick();

    bus.publish('numeric', 1, { id: 1 });
    bus.publish('numeric', 1, { id: 2 });
    bus.publish('numeric', 1, { id: 3 });

    expect(await consumer.values).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(asked()).toEqual([]);
    await consumer.stop();
  });

  it('treats minIntervalMs 0 as no throttle at all', async () => {
    // `<= 0` means inactive, and the bus expresses that by not wrapping — so an
    // explicit 0 must be indistinguishable from an absent option, not a throttle
    // with a zero-length window that still sleeps.
    const { clock } = advanceableClock(EPOCH);
    const { delay, asked } = manualDelay();
    const bus = createEventBus(FIXTURE_TOPICS, { clock, delay });

    const consumer = consume(bus.subscribe('numeric', 1, { minIntervalMs: 0 }), 3);
    await tick();

    bus.publish('numeric', 1, { id: 1 });
    bus.publish('numeric', 1, { id: 2 });
    bus.publish('numeric', 1, { id: 3 });

    expect(await consumer.values).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(asked()).toEqual([]);
    await consumer.stop();
  });

  it('keeps a throttled subscription keyed: the window never lets another key in', async () => {
    // Rate limiting is applied AFTER routing, so the operator must not become a
    // hole in the isolation law — a coalescing buffer that held the wrong key's
    // payload would be the worst of both.
    const { clock, advance } = advanceableClock(EPOCH);
    const { delay, release } = manualDelay();
    const bus = createEventBus(FIXTURE_TOPICS, { clock, delay });

    const consumer = consume(bus.subscribe('numeric', 1, { minIntervalMs: 50 }), 2);
    await tick();

    bus.publish('numeric', 1, { id: 1 });
    await tick();

    bus.publish('numeric', 2, { id: 999 }); // another user, inside our window
    bus.publish('numeric', 1, { id: 3 });
    await tick();

    advance(50);
    release();

    expect(await consumer.values).toEqual([{ id: 1 }, { id: 3 }]);
    await consumer.stop();
  });

});

// --- Cancellation ----------------------------------------------------------

describe('cancellation', () => {
  // A subscription's lifetime is a socket's lifetime, and a long-lived server
  // that keeps one event-target listener per closed socket dies slowly. The
  // counting target below makes the unsubscribe OBSERVABLE — "no value arrived
  // afterwards" would also hold for a leaked-but-idle listener, which is exactly
  // the bug this pins.

  it('removes its event-target listener when an unthrottled stream is cancelled', async () => {
    const { target, listeners } = countingTarget();
    const bus = createEventBus(FIXTURE_TOPICS, { clock: fixedClock(EPOCH), eventTarget: target });

    const consumer = consume(bus.subscribe('numeric', 1), 1);
    await tick();
    expect(listeners()).toBe(1);

    bus.publish('numeric', 1, { id: 1 });
    expect(await consumer.values).toEqual([{ id: 1 }]);

    await consumer.stop();
    await tick();
    expect(listeners()).toBe(0);

    // Fire-and-forget into a stream nobody holds: it must not throw.
    expect(() => {
      bus.publish('numeric', 1, { id: 2 });
    }).not.toThrow();
  });

  it('propagates cancellation through the throttle wrapper to the source', async () => {
    // The `finally` in `throttle` returns the UPSTREAM iterator. Delete it and
    // the generator still stops, the consumer still sees nothing more, and every
    // other assertion in this file still passes — only the listener count tells
    // the truth.
    const { target, listeners } = countingTarget();
    const { clock } = advanceableClock(EPOCH);
    const { delay } = manualDelay();
    const bus = createEventBus(FIXTURE_TOPICS, { clock, delay, eventTarget: target });

    const consumer = consume(bus.subscribe('numeric', 1, { minIntervalMs: 50 }), 1);
    await tick();
    expect(listeners()).toBe(1);

    bus.publish('numeric', 1, { id: 1 }); // leading edge, so the value lands at a yield
    expect(await consumer.values).toEqual([{ id: 1 }]);

    await consumer.stop();
    await tick();
    expect(listeners()).toBe(0);
  });
});
