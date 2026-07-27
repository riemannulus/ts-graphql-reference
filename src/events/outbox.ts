import type { Db, DbClient } from '../db/db.js';
import { lockKey } from '../db/lock-registry.js';
import { uow } from '../db/uow.js';
import type { Clock } from '../foundation/clock.js';
import type { Logger } from '../foundation/logger.js';
import { addDays } from '../foundation/time.js';
import { TOPICS, type AppEventPublisher, type AppTopics, type TopicName } from './event-registry.js';
import { decodeTopicKey, encodeTopicKey, type TopicKey, type TopicPayload } from './events.js';
import * as outboxRepo from './outbox.repo.js';

/**
 * The transactional outbox — rung 1 of the delivery ladder, and the counterpart
 * to `event-bus.ts`'s rung 0.
 *
 * Rung 0 (`events.publish` after commit) loses an event if the process dies in
 * the gap; that is fine when a subscription is a cache-invalidation hint and the
 * client re-queries on reconnect, which is most topics. Rung 1 exists for the
 * ones where losing it is a money or reconciliation problem: the event is written
 * in the SAME transaction as the domain write, so it commits or vanishes with it,
 * and a drainer publishes it afterwards. Pick the lower rung unless you cannot.
 *
 * ## Why publishing happens OUTSIDE the transaction
 *
 * The obvious design — claim, publish, mark, all in one transaction — is wrong
 * twice. It holds row locks across a network round-trip to Redis, and a publish
 * failure rolls back the attempt counter it just incremented, so a poison row
 * retries forever. So the drain is three phases:
 *
 *   1. one transaction: retire exhausted rows, then claim a batch with
 *      `FOR UPDATE SKIP LOCKED` and count the attempt — commit;
 *   2. no transaction: publish each claimed row to the bus;
 *   3. one transaction: mark the delivered ones.
 *
 * The cost is a window between (1) and (3) where a crash leaves rows claimed,
 * attempted, and unpublished — they are simply picked up again later, so an event
 * can be delivered TWICE. That is the at-least-once bargain, and it is only
 * payable because payloads carry ids and the resolver re-fetches current state,
 * which makes a duplicate indistinguishable from a single delivery (the five
 * laws, CONVENTIONS §11). Ordering is given up for the same reason.
 *
 * ## Why `notify()` is not correctness
 *
 * `notify()` wakes the drainer in-process right after a commit, which is the
 * difference between millisecond and up-to-30-second delivery. It is an
 * optimization only: the scheduled `events:outbox:drain` job is the authority,
 * and it is what picks up rows another instance enqueued or that a crash left
 * behind. Nothing may depend on `notify()` having run — the same discipline
 * crepe's IAP ingest gets wrong when its `created` gate skips the enqueue on a
 * redelivery (design spec §16.3).
 */

/** How many rows one claim takes. Small enough that a turn stays short. */
const DEFAULT_BATCH_SIZE = 100;
/** Attempts before a row is retired to the DLQ. Mirrors crepe's IAP sweep budget. */
const DEFAULT_MAX_ATTEMPTS = 6;
/**
 * Upper bound on batches per `drain()` call, so a large backlog cannot starve
 * the event loop or a shutdown. Whatever is left waits for the next turn.
 */
const MAX_TURNS_PER_DRAIN = 50;
/**
 * How long a DELIVERED row is kept before the retention sweep removes it. Long
 * enough to answer "did this event go out?" during an incident; a FAILED row is
 * never purged, because it is the evidence.
 */
const RETENTION_DAYS = 7;

export interface OutboxDeps {
  db: Db;
  /** The write half of the bus. The outbox publishes; it never subscribes. */
  bus: AppEventPublisher;
  clock: Clock;
  logger: Logger;
  batchSize?: number | undefined;
  maxAttempts?: number | undefined;
}

export interface Outbox {
  /**
   * Enqueues an event in the CALLER's transaction. Pass the `tx` handed to the
   * `uow` body — passing `db.rw` instead silently drops back to rung 0 semantics
   * with extra steps, because the row would commit independently of the write.
   */
  enqueue<K extends TopicName>(
    tx: DbClient,
    topic: K,
    key: TopicKey<AppTopics[K]>,
    payload: TopicPayload<AppTopics[K]>,
  ): Promise<void>;
  /** Wakes the drainer after a commit. Fire-and-forget, never throws. */
  notify(): void;
  /** Drains until empty (bounded). Returns how many events were published. */
  drain(): Promise<number>;
  /**
   * Retention sweep for delivered rows; the scheduled `:purge` job calls it.
   * Takes no cutoff: the outbox owns the clock, so the job handler stays a thin
   * delegate and never reads time itself (CONVENTIONS §10).
   */
  purge(): Promise<number>;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // Serializes drains within THIS process; across processes the DB claim is what
  // coordinates. `wakeAgain` records a notify that arrived mid-drain so the
  // event it announced is not left waiting for the scheduled turn.
  let draining = false;
  let wakeAgain = false;

  /**
   * One take → publish → mark cycle. Returns rows published this turn, or 0 when
   * another drainer already holds the lock.
   *
   * `trySerialized`, not `serialized`: a drainer that cannot get the lock should
   * shrug and wait for its next tick, not queue up behind the holder and then
   * run a redundant pass. That is the primitive's documented purpose.
   *
   * The lock is an optimization and nothing depends on holding it — see
   * `lock-registry.outboxDrain`. It cannot be held across the publish anyway:
   * `pg_advisory_xact_lock` is transaction-scoped, and publishing inside the
   * transaction is exactly what phase 2 exists to avoid.
   */
  async function drainTurn(): Promise<number> {
    const taken = await uow.trySerialized(deps.db, [lockKey.outboxDrain()], async (tx) => {
      await outboxRepo.failExhausted(tx, maxAttempts, deps.clock.now());
      return outboxRepo.takePending(tx, { limit: batchSize, maxAttempts });
    });
    // Someone else is draining. Their batch covers ours, so there is nothing to
    // do and nothing to report.
    if (!taken.acquired) return 0;
    const claimed = taken.result;
    if (claimed.length === 0) return 0;

    const published: string[] = [];
    const unroutable: string[] = [];
    for (const row of claimed) {
      const spec = TOPICS[row.topic as TopicName] as { keyKind: 'string' | 'number' } | undefined;
      if (spec === undefined) {
        // The row names a topic the registry no longer has (a deploy removed it,
        // or the column was written outside the codec). It can never be routed,
        // so retire it now rather than burning attempts on it.
        unroutable.push(row.id);
        deps.logger.error({ outboxId: row.id, topic: row.topic }, 'outbox row names an unknown topic');
        continue;
      }
      try {
        const key = decodeTopicKey(spec.keyKind, row.key);
        deps.bus.publish(row.topic as TopicName, key as never, row.payload as never);
        published.push(row.id);
      } catch (error) {
        // Left unpublished with its attempt spent: the next turn retries it, and
        // `failExhausted` retires it once the budget runs out.
        deps.logger.error(
          { outboxId: row.id, topic: row.topic, err: error },
          'outbox publish failed; will retry',
        );
      }
    }

    const now = deps.clock.now();
    await uow.run(deps.db, async (tx) => {
      await outboxRepo.markPublished(tx, published, now);
      await outboxRepo.markFailed(tx, unroutable, now);
    });
    return published.length;
  }

  async function drain(): Promise<number> {
    let total = 0;
    for (let turn = 0; turn < MAX_TURNS_PER_DRAIN; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- batches are sequential by design; the backlog is drained in order
      const published = await drainTurn();
      total += published;
      if (published < batchSize) break;
    }
    return total;
  }

  /** Runs `drain` to quiescence, swallowing errors — a wake-up must never throw. */
  async function drainLoop(): Promise<void> {
    draining = true;
    try {
      do {
        wakeAgain = false;
        // eslint-disable-next-line no-await-in-loop -- re-drains only when a notify landed mid-drain
        await drain();
      } while (wakeAgain);
    } catch (error) {
      deps.logger.error({ err: error }, 'outbox drain failed; the scheduled drain will retry');
    } finally {
      draining = false;
    }
  }

  return {
    async enqueue(tx, topic, key, payload) {
      await outboxRepo.enqueue(tx, {
        topic,
        key: encodeTopicKey(key),
        // Payloads are plain id objects by law, so this is a JSON value; the
        // column type cannot express that, hence the one cast.
        payload: payload as Record<string, string | number>,
      });
    },

    notify() {
      if (draining) {
        wakeAgain = true;
        return;
      }
      // `void` is the sanctioned fire-and-forget idiom here (see server.ts);
      // `drainLoop` never rejects, so nothing is swallowed silently.
      void drainLoop();
    },

    drain,

    purge() {
      // One mint, at the top of the read phase, handed on as data.
      const cutoff = addDays(deps.clock.now(), -RETENTION_DAYS);
      return uow.run(deps.db, (tx) => outboxRepo.purgePublished(tx, cutoff));
    },
  };
}
