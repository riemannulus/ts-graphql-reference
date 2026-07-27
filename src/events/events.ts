/**
 * Event MACHINERY — the topic-spec kind, the `topic` / `defineTopics` builders,
 * the derived publisher/subscriber TYPES, and the outbox key codec. This is the
 * `flags/flags.ts` analogue one directory over (and `db/locks.ts` before it):
 * WHAT is published lives in `event-registry.ts`, the ONE file that grows, while
 * HOW a topic binds to a fan-out backend lives in `event-bus.ts`, the `uow.ts`-
 * style I/O shell. This module imports NOTHING — not the Yoga pub/sub, not
 * Prisma, not a feature module's row type — so `events/` stays a leaf of the
 * import graph exactly as the lock registry does (oxlint fences the layers,
 * dependency-cruiser fences `events/ → modules/`).
 *
 * A topic SPEC is the declaration of one event stream: the KIND of its routing
 * key plus a one-line `doc`, mirroring the `doc` field `flags.ts` requires of
 * every flag spec so the catalog reads as its own documentation. `defineTopics`
 * is the identity-with-inference helper that pins the literal map, so a typo in
 * a topic name is a compile error and each topic's key/payload types live in
 * exactly one place — the same trick, for the same reason, as `defineFlags`.
 *
 * ## Why `TKey` / `TPayload` are PHANTOM
 *
 * A `TopicSpec` carries its type parameters only in optional `__key` /
 * `__payload` fields that are never assigned: nothing at runtime holds them.
 * That is a DELIBERATE departure from `flags.ts`, whose type parameter rides in
 * REAL runtime fields (`default`, `variants`) because a reader must be able to
 * MINT a value when no backend answers. An event has no default — the bus never
 * mints a payload, it only relays the one a publisher already built — so the
 * only work left for `TKey`/`TPayload` is typing the call sites, and a phantom
 * field is the cheapest carrier for a type with no runtime witness. The one
 * thing the bus genuinely needs at runtime is `keyKind`, because the outbox
 * round-trips the key through a TEXT column (see the codec at the bottom of this
 * file); the conditional parameter type on `topic` welds that tag to `TKey`, so
 * `topic<number, …>('string')` does not compile and tag and type cannot drift.
 *
 * ## The name-collision hazard
 *
 * `EventBus<T>` is an INTERSECTION whose own members are `publish` and
 * `subscribe`, while topic names live in the key POSITION (`publish('x', …)`)
 * rather than as members — so a topic literally named `publish` is inert today.
 * It stops being inert the moment anyone derives per-topic accessors the way
 * `FlagReader` maps `[K in keyof T]` beside its `assert` namespace: the topic
 * name would then shadow a bus member. Nothing here guards against it, and
 * `flags.ts` carries the identical unguarded hazard for a flag named `assert`.
 * In both files the registry is short and hand-reviewed, and the guard (an
 * `Exclude<keyof T, 'publish' | 'subscribe'>` constraint threaded through every
 * signature) would cost more clarity than the hazard is worth.
 *
 * How to extend: a new topic is ONE line in `event-registry.ts` and nothing
 * here changes. A new key kind (`'bigint'`, say) is a `KeyKind` member plus one
 * entry in the `KEY_DECODERS` table — the table is exhaustive over `KeyKind`, so
 * forgetting the entry is a compile error — and still nothing else changes: not
 * `topic`, not `defineTopics`, not the bus types, not a single call site.
 */

/**
 * The runtime tag for a topic key's type — a CODEC selector, not decoration.
 * The outbox stores `key` in a TEXT column (delivery-ladder rung 1), so a
 * drainer reading a row back cannot tell whether `'42'` meant the number 42 or
 * the string '42' unless the spec says. `topic`'s conditional parameter type
 * forces this tag to agree with `TKey`, which is what makes `decodeTopicKey`
 * total rather than a guess.
 */
export type KeyKind = 'string' | 'number';

/**
 * One topic's declaration: how its routing key is encoded, and what it is for.
 * `keyKind` is the only field with a runtime life; `__key` / `__payload` are
 * phantom (see the module block above) and are never assigned by `topic`.
 */
export interface TopicSpec<TKey extends string | number, TPayload> {
  /** The key's codec tag — see `KeyKind`, and `encodeTopicKey` / `decodeTopicKey`. */
  readonly keyKind: KeyKind;
  /** One-line description. Mirrors the `doc` field `flags.ts` requires of every spec. */
  readonly doc: string;
  /** PHANTOM — type-only, never assigned. Carries the routing-key type. */
  readonly __key?: TKey;
  /** PHANTOM — type-only, never assigned. Carries the payload type. */
  readonly __payload?: TPayload;
}

/**
 * Declares a topic: its key type, its payload type, and the tag that says how
 * the key survives the outbox's TEXT column. The parameter's CONDITIONAL type is
 * the load-bearing part — `TKey extends number ? 'number' : 'string'` makes
 * `topic<number, P>('string')` a compile error, so the runtime tag and the
 * compile-time key type can never disagree. Both type arguments are supplied
 * explicitly at the call site (there is no value to infer them from — they are
 * phantom), which is exactly why the tag needs welding.
 */
export const topic = <TKey extends string | number, TPayload>(
  keyKind: TKey extends number ? 'number' : 'string',
  doc: string,
): TopicSpec<TKey, TPayload> => ({ keyKind, doc });

/** Every topic map's shape — the constraint `defineTopics` and the bus types speak. */
export type Topics = Record<string, TopicSpec<string | number, unknown>>;

/**
 * Pins a topic-registry literal so its names, key kinds, and payload types are
 * single-sourced and the bus can derive typed `publish` / `subscribe` from it.
 * Identity at runtime (the value IS the object passed in); `const T` captures
 * the exact literal for the type level, precisely as `defineFlags` does — drop
 * the `const` and every topic name widens to `string`, taking the typo check
 * with it.
 */
export const defineTopics = <const T extends Topics>(topics: T): T => topics;

/** The registered topic names of a registry — `keyof T` narrowed to the string keys. */
export type TopicName<T extends Topics> = keyof T & string;

/** The routing-key type a spec declares, recovered from its phantom field. */
export type TopicKey<S> = S extends TopicSpec<infer K, unknown> ? K : never;

/** The payload type a spec declares, recovered from its phantom field. */
export type TopicPayload<S> = S extends TopicSpec<string | number, infer P> ? P : never;

/**
 * The declarative stream configuration a subscriber may ask for at subscribe
 * time — the ONLY stream-control channel the delivery layer gets. A schema file
 * DECLARES a rate here; it never assembles operators itself (there is no raw
 * `pipe` escape hatch), the same way a filtered relation count is declarative
 * plugin config rather than a filter smuggled through a repo signature
 * (CONVENTIONS §2).
 */
export interface SubscribeOptions {
  /**
   * Minimum gap between two emissions of this subscription, in milliseconds.
   * While suppressed the bus keeps only the most recent event and drops the
   * rest — LOSSLESS, because a payload carries ids only and the resolver
   * re-fetches (the five laws, CONVENTIONS §11). Absent or `<= 0` means the
   * operator is inactive; the policy is the pure `planEmit` in `rate.ts`.
   */
  minIntervalMs?: number;
}

/**
 * The WRITE half of the bus: fire-and-forget fan-out (delivery rung 0,
 * at-most-once). Call it only AFTER the transaction commits — publishing inside
 * `uow` means a rollback hands subscribers an event for a row that does not
 * exist, their re-fetch throws, and the subscription dies. Only a SERVICE may
 * hold this half (lint-enforced): it is the choke point every caller passes
 * through.
 */
export interface EventPublisher<T extends Topics> {
  publish<K extends TopicName<T>>(topic: K, key: TopicKey<T[K]>, payload: TopicPayload<T[K]>): void;
}

/**
 * The READ half of the bus, and the type of `ctx.events`. Splitting it from
 * `EventPublisher` is the `ReadDbClient` move: a resolver cannot publish because
 * the member is not on its type — a compile-time fact, not a convention. The
 * returned iterable yields payloads for ONE key, so filtering is routing (never
 * a `filter` operator over everybody's events).
 */
export interface EventSubscriber<T extends Topics> {
  subscribe<K extends TopicName<T>>(
    topic: K,
    key: TopicKey<T[K]>,
    options?: SubscribeOptions,
  ): AsyncIterable<TopicPayload<T[K]>>;
}

/** Both halves — what the composition root builds and hands out in pieces. */
export type EventBus<T extends Topics> = EventPublisher<T> & EventSubscriber<T>;

/**
 * Serializes a topic key to the TEXT form the outbox stores. Total and trivial
 * by design: the outbox column is TEXT so that one index and one codec cover
 * every topic whatever its key type. Note the round trip is `===`-total, not
 * `Object.is`-total — `-0` encodes to `'0'` and decodes to `0` — which no id
 * scheme can observe.
 */
export function encodeTopicKey(key: string | number): string {
  return String(key);
}

/**
 * A stored topic key that will not parse back — CORRUPTION, not a client error,
 * so this is a plain (masked) Error rather than a `DomainError`, exactly as
 * `UnknownUserStatusError` is for an out-of-set status. A correct system cannot
 * produce one: every row is written through `encodeTopicKey` under the spec's
 * own `keyKind`, so reaching here means the column was written by something that
 * bypassed the codec.
 */
export class UnparsableTopicKeyError extends Error {
  constructor(
    readonly keyKind: KeyKind,
    readonly raw: string,
  ) {
    super(`Unparsable ${keyKind} topic key read from storage: ${JSON.stringify(raw)}`);
    this.name = 'UnparsableTopicKeyError';
  }
}

/**
 * One decoder per key kind. Exhaustiveness lives in the TYPE, never in an
 * if-chain — the same move CONVENTIONS §9 mandates for a variant flag's
 * `Record<Variant, Impl>` lookup: adding a `KeyKind` without a decoder here is a
 * compile error, so the tag and its codec cannot come apart. The `'number'`
 * decoder refuses everything `Number()` would coerce silently (`''` → 0, `'  '`
 * → 0, `'x'` → NaN, `'1e999'` → ∞) rather than quietly routing an event to key 0.
 */
const KEY_DECODERS: Record<KeyKind, (raw: string) => string | number> = {
  string: (raw) => raw,
  number: (raw) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      throw new UnparsableTopicKeyError('number', raw);
    }
    return parsed;
  },
};

/**
 * The total inverse of `encodeTopicKey`, driven by the spec's `keyKind` tag —
 * parse, don't validate (CONVENTIONS §4): a TEXT column becomes a typed routing
 * key only through here, and a value a correct system cannot produce throws
 * rather than being coerced to a default. Total over `KeyKind` by the table
 * above; total over `raw` in the sense that every string either parses or
 * raises `UnparsableTopicKeyError`.
 */
export function decodeTopicKey(keyKind: KeyKind, raw: string): string | number {
  return KEY_DECODERS[keyKind](raw);
}
