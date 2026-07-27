import { createRedisEventTarget } from '@graphql-yoga/redis-event-target';
import { Redis } from 'ioredis';
import type { TypedEventTarget } from '@graphql-yoga/typed-event-target';

/**
 * The event-bus DRIVER — the `scheduler/agenda.ts` analogue.
 *
 * `event-bus.ts` is the I/O shell that binds the topic registry to a Yoga
 * `PubSub`; WHERE that pubsub fans out to is a separate concern, and this file
 * is the one place a concrete backend is constructed. The bus depends only on
 * the `EventTarget` shape, so swapping Redis for something else (a Postgres
 * `LISTEN`/`NOTIFY` target, say — the payload is ids only, so it fits well
 * inside NOTIFY's 8000-byte limit) is a new file beside this one plus one line
 * in `server.ts`. Nothing above the bus learns which backend is in play.
 *
 * The adapter itself is upstream's (`@graphql-yoga/redis-event-target`), not a
 * hand-rolled one: it is the same implementation crepe runs, which keeps the
 * migration boring. **The version floor matters.** `1.0.0` — the version crepe
 * pins — depends on `@graphql-yoga/typed-event-target@^1`, while the
 * `@graphql-yoga/subscription@5` that `graphql-yoga@5.21` pulls in depends on
 * `^3.0.2`. Handing a v1 target to `createPubSub` is a type error across that
 * split, so this package must stay at `^3.0.3`.
 *
 * With no `REDIS_URL` configured the composition root passes no target at all
 * and the bus falls back to Yoga's in-process `EventTarget` — correct for a
 * single instance and for every test, and the reason the test suite never
 * touches Redis.
 */

/** Everything the bus needs of a fan-out backend: a typed `EventTarget`. */
export type EventFanout = TypedEventTarget<CustomEvent>;

export interface RedisEventTargetHandle {
  /** Hand this to `buildApp({ eventTarget })`. */
  readonly target: EventFanout;
  /** Closes both connections. The composition root owns this (see server.ts). */
  close(): Promise<void>;
}

/**
 * Builds a Redis-backed fan-out target from one connection string.
 *
 * TWO connections are required, not one: a Redis client in subscriber mode may
 * only issue (un)subscribe commands, so publishing needs its own connection.
 * That is a Redis protocol constraint, not a library quirk.
 *
 * Unlike crepe's `src/pubsub.ts` — which opens both connections at import time,
 * making the module unusable in a test and impossible to inject — nothing here
 * runs until the composition root calls it, and the handle it returns is what
 * `server.ts` closes on shutdown.
 */
export function createRedisFanout(url: string): RedisEventTargetHandle {
  const publishClient = new Redis(url);
  const subscribeClient = new Redis(url);

  return {
    target: createRedisEventTarget({ publishClient, subscribeClient }),
    async close() {
      // `quit` drains in-flight commands; both are closed even if the first
      // rejects, so a half-open pair cannot keep the process alive.
      await Promise.allSettled([publishClient.quit(), subscribeClient.quit()]);
    },
  };
}
