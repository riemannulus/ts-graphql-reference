/**
 * The event registry — the ONE place that says WHAT is published, kept apart
 * from the machinery (`events.ts`) and the client binding (`event-bus.ts`) so
 * this is the only file that grows. Each entry is one topic: its key kind, its
 * key and payload TYPES, and the JSDoc that says who publishes it and why. Add a
 * topic here; `events.ts` and `event-bus.ts` do not change. It is the
 * `flag-registry.ts` / `lock-registry.ts` analogue — the growing catalog on top
 * of fixed machinery.
 *
 * Like `events.ts`, this module stays pure — no I/O, no pub/sub SDK, no
 * framework deps (lint-enforced) — and it imports NO feature module
 * (dependency-cruiser keeps `events/` a leaf). A payload type is therefore
 * written STRUCTURALLY here (`{ userId: number }`), never pulled from a module;
 * that is not a limitation but the point, since a payload carries ids only and
 * has no reason to know a Prisma row.
 */
import {
  defineTopics,
  topic,
  type EventBus,
  type EventPublisher,
  type EventSubscriber,
} from './events.js';

/** The ONLY declaration of the app's topics. Add an entry to publish something new. */
export const TOPICS = defineTopics({
  /**
   * RUNG 0 + RUNG 1 — a user's point balance moved. `point.service` publishes it
   * from all four use-cases (`charge` / `spend` / `transfer` / `expire`), each
   * AFTER its transaction commits; `charge` goes the extra rung and enqueues it
   * in the outbox inside the same transaction, because money arriving and not
   * showing up is a reconciliation problem rather than a cosmetic one. Two rungs
   * for one topic is normal — that is what a ladder is for.
   *
   * KEY = `userId`, so routing IS the authorization filter's first half: a
   * subscriber only ever receives its own key's events, and the resolver's
   * re-fetch `where` re-checks ownership from the principal on every event.
   *
   * The payload carries IDS ONLY — no balance figures. The subscriber re-fetches
   * with the Pothos `query`, so it gets its own selection set at current state;
   * a shipped balance would be stale on arrival, would leak columns nobody
   * selected, and would make duplicate or out-of-order outbox delivery
   * observable instead of harmless (the five laws, law 1).
   */
  pointBalanceChanged: topic<number, { userId: number }>(
    'number',
    "A user's point balance changed.",
  ),
});

/** The app's topic map — the type argument every `events/` shell is generic over. */
export type AppTopics = typeof TOPICS;

/**
 * The registered topic names, derived from the registry — a typo at a call site
 * is a compile error. No `& string` narrowing here (unlike the generic
 * `TopicName<T>` in `events.ts`, where `T` is unresolved and the intersection
 * does real work): the keys of a concrete literal map are already string
 * literals, so the intersection would be redundant — lint says so, and
 * `FlagName` in `flag-registry.ts` has the same plain shape.
 */
export type TopicName = keyof AppTopics;

/** The publish half, bound to this registry — held by services only (law 3). */
export type AppEventPublisher = EventPublisher<AppTopics>;

/** The subscribe half, bound to this registry — the type of `ctx.events`. */
export type AppEventSubscriber = EventSubscriber<AppTopics>;

/** Both halves — what the composition root builds before handing out the pieces. */
export type AppEventBus = EventBus<AppTopics>;
