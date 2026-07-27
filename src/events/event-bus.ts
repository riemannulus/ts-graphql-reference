import type { TypedEventTarget } from '@graphql-yoga/typed-event-target';
import { createPubSub } from 'graphql-yoga';
import type { Clock } from '../foundation/clock.js';
import type {
  EventBus,
  SubscribeOptions,
  TopicKey,
  TopicName,
  TopicPayload,
  Topics,
} from './events.js';
import { systemDelay, throttle, type Delay } from './operators.js';

/**
 * The event bus — the I/O shell of the events facade, and the exact analogue of
 * `flag-reader.ts`: `events.ts` holds the machinery, `event-registry.ts` says
 * WHAT exists, and this one file binds the catalog to a live client. It is the
 * ONLY file that imports `graphql-yoga`'s `createPubSub`.
 *
 * Two things are deliberately NOT here. The fan-out backend is not constructed
 * here — an `eventTarget` arrives injected (see `redis-event-target.ts`), so the
 * bus never learns whether it is talking to one process or twenty, and the test
 * suite never touches Redis. And there is no raw `pipe` escape hatch on the
 * public surface: the only stream control is `SubscribeOptions`, applied here,
 * so a delivery layer DECLARES a rate rather than assembling operators
 * (CONVENTIONS §2's "declarative plugin config" rule, applied to streams).
 *
 * The bus is a long-lived singleton built once in the composition root — it is
 * NOT per-request state like `ctx.flags`. What is per-request is the half each
 * consumer is handed: services get `EventPublisher`, `ctx.events` gets
 * `EventSubscriber`, and neither can reach the other's methods.
 */

/**
 * The publish-args map Yoga's `createPubSub` is generic over, derived from our
 * registry: one entry per topic, `[key, payload]`. Deriving it (rather than
 * hand-writing Yoga's shape, as crepe's `src/pubsub.ts` does) is what makes the
 * registry the single source of truth — a topic added there is publishable here
 * with no second edit, and a typo is a compile error.
 */
type PubSubMap<T extends Topics> = {
  [K in TopicName<T>]: [key: TopicKey<T[K]>, payload: TopicPayload<T[K]>];
};

export interface EventBusDeps {
  /**
   * Distributed fan-out. Omit it and Yoga builds an in-process `EventTarget`,
   * which is correct for a single instance and for every test. Production passes
   * the Redis-backed target when `REDIS_URL` is set (see `server.ts`).
   */
  eventTarget?: TypedEventTarget<CustomEvent> | undefined;
  /** The `now` seam the rate operator decides against (CONVENTIONS §10). */
  clock: Clock;
  /** The sleep seam; tests inject a deterministic one. See `operators.ts`. */
  delay?: Delay | undefined;
}

/**
 * Binds a topic catalog to a pubsub instance.
 *
 * `topics` is used at runtime for one thing: rejecting a topic name that is not
 * in the registry. The typed surface makes that unreachable, but the outbox
 * drainer publishes from a topic name it read out of a TEXT column, so the guard
 * is the boundary where a corrupted row fails loudly instead of fanning out to a
 * channel nobody is listening on.
 *
 * The closing `as unknown as EventBus<T>` is the sanctioned double cast (see
 * `flag-reader.ts`, which does the same): the mapped return type cannot be
 * proven from a body that indexes a generic record, and the type safety that
 * matters is at the CONSUMER boundary, which `EventBus<T>` provides.
 *
 * Add a topic in `event-registry.ts`; nothing in this file changes.
 */
export function createEventBus<const T extends Topics>(
  topics: T,
  deps: EventBusDeps,
): EventBus<T> {
  const pubsub = createPubSub<PubSubMap<T>>(
    deps.eventTarget === undefined
      ? {}
      : // Yoga narrows the target's event type per topic; ours is uniform
        // (`CustomEvent`), which the adapters produce. The cast is at this one
        // boundary rather than smeared over every call site.
        ({ eventTarget: deps.eventTarget } as never),
  );
  const delay = deps.delay ?? systemDelay;

  const bus = {
    publish(topic: string, key: string | number, payload: unknown): void {
      if (!Object.hasOwn(topics, topic)) {
        // Corruption, not a client error — a plain (masked) Error, exactly as
        // `decodeTopicKey` raises for an unparsable stored key.
        throw new Error(`Unknown event topic: ${JSON.stringify(topic)}`);
      }
      (pubsub.publish as (t: string, k: string | number, p: unknown) => void)(topic, key, payload);
    },

    subscribe(topic: string, key: string | number, options?: SubscribeOptions): AsyncIterable<unknown> {
      const source = (
        pubsub.subscribe as unknown as (t: string, k: string | number) => AsyncIterable<unknown>
      )(topic, key);
      const minIntervalMs = options?.minIntervalMs ?? 0;
      // Skip the wrapper entirely when unthrottled, so the common case pays
      // nothing and the stream is the Repeater the pubsub returned.
      return minIntervalMs > 0 ? throttle(minIntervalMs, deps.clock, delay)(source) : source;
    },
  };

  return bus as unknown as EventBus<T>;
}
