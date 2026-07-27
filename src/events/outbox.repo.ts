import type { Prisma } from '@prisma/client';
import type { DbClient } from '../db/db.js';

/**
 * Persistence for the transactional outbox (delivery ladder rung 1).
 *
 * Like every repo here, it never picks a client: the caller passes the handle,
 * which is how `enqueue` joins the SAME transaction as the domain write — that
 * shared transaction IS the guarantee the rung buys.
 *
 * Two boundary conversions happen in this file and nowhere else:
 *
 * - **`BigInt` never escapes.** `OutboxEvent.id` is the only `BigInt` in the
 *   schema, and `JSON.stringify` THROWS on a JS `bigint` — one logged row would
 *   take down a drain. Ids leave here as `string` and come back as `string`.
 * - **`payload` is handed out as `unknown`.** It is a `Json` column, so Prisma
 *   types it `JsonValue`; the drainer gets `unknown` and the topic's own codec
 *   decides what it is (CONVENTIONS §4, parse don't validate).
 *
 * There is NO raw SQL here, and that is a deliberate constraint rather than an
 * accident: `db/uow.ts` is the one place in this codebase that writes raw
 * transaction or lock SQL, and its own doc comment says so. A queue whose
 * correctness rests on a guarded write (see `markPublished`) does not need to
 * break that.
 */

/** One row to enqueue. `payload` is ids only — see the five laws (CONVENTIONS §11). */
export interface EnqueueOutboxInput {
  topic: string;
  /** The topic key, already TEXT-encoded by `encodeTopicKey`. */
  key: string;
  payload: Prisma.InputJsonValue;
}

/** A claimed row, with the id rendered as text so no `bigint` crosses this line. */
export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly key: string;
  readonly payload: unknown;
}

export interface ClaimOptions {
  /** Batch size — how many rows one drain turn takes. */
  limit: number;
  /** Rows at or above this many attempts are left for an operator, not retried. */
  maxAttempts: number;
}

/**
 * Writes an event into the outbox. Called with the SAME `tx` as the domain write
 * it accompanies, so the two commit together or not at all — a rollback leaves no
 * event, which is the whole point of the rung.
 *
 * Uses the Prisma delegate rather than raw SQL on purpose: Prisma fills
 * `@default(now())` for `createdAt`, and a raw INSERT would have to supply every
 * defaulted column by hand.
 */
export async function enqueue(db: DbClient, input: EnqueueOutboxInput): Promise<void> {
  await db.outboxEvent.create({
    data: { topic: input.topic, key: input.key, payload: input.payload },
  });
}

/**
 * Takes the next batch of pending rows and counts the attempt.
 *
 * Plain Prisma, deliberately — there is no `FOR UPDATE SKIP LOCKED` here, and an
 * earlier draft that had one was solving a problem it did not have. Mutual
 * exclusion between drainers holds NO invariant: delivery is correct because the
 * mark is a guarded write (`markPublished` requires `publishedAt: null`), and a
 * duplicate delivery is unobservable anyway (payloads are ids, the subscriber
 * re-fetches). Coordination is a WORK-saving measure, so it belongs where the
 * codebase already puts it — `uow.trySerialized` around the caller, reached
 * through the toolkit (see `outbox.ts`). That keeps the toolkit's own claim true:
 * `db/uow.ts` holds all the raw lock SQL in this codebase, and a repo issues
 * none.
 *
 * Ordering: `orderBy: id` plus a single drainer at a time means events normally
 * go out in the order they were enqueued. That is a happy consequence of the
 * lock, not a guarantee — a drain that loses the lock mid-cycle can interleave
 * with the next holder — so nothing may depend on it.
 *
 * The attempt is counted HERE, in the same transaction as the read, rather than
 * after a failed publish: the publish happens outside any transaction (see
 * `outbox.ts`), so a crash between the two must still burn an attempt or a
 * poison row would be retried forever.
 *
 * `id` is the schema's only `BigInt`, and `JSON.stringify` throws on a JS
 * `bigint` — one logged row would take down a drain. It leaves here as `string`
 * and comes back as `string`; the conversions are confined to this file.
 */
export async function takePending(
  db: DbClient,
  options: ClaimOptions,
): Promise<ClaimedOutboxEvent[]> {
  const rows = await db.outboxEvent.findMany({
    where: { publishedAt: null, failedAt: null, attempts: { lt: options.maxAttempts } },
    orderBy: { id: 'asc' },
    take: options.limit,
    select: { id: true, topic: true, key: true, payload: true },
  });
  if (rows.length === 0) return [];

  await db.outboxEvent.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { attempts: { increment: 1 } },
  });

  return rows.map((row) => ({
    id: row.id.toString(),
    topic: row.topic,
    key: row.key,
    payload: row.payload,
  }));
}

/**
 * Marks rows delivered. `publishedAt` arrives as a parameter — a repo never mints
 * a decision instant, the service reads it from the injected clock once
 * (CONVENTIONS §10 rule 1). Returns how many rows moved, which the drainer logs.
 *
 * The `publishedAt: null` predicate is the whole of the correctness story — it
 * is what makes the mark idempotent, and therefore why the drain needs no row
 * lock upstream of it.
 *
 * Deliberately NOT a guarded write: a concurrent drainer that also delivered the
 * row and marked it first is a duplicate delivery, which is expected under
 * at-least-once and harmless here — turning it into a `ConcurrentUpdateError`
 * would fail a drain over a non-problem.
 */
export async function markPublished(
  db: DbClient,
  ids: readonly string[],
  publishedAt: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await db.outboxEvent.updateMany({
    where: { id: { in: ids.map((id) => BigInt(id)) }, publishedAt: null },
    data: { publishedAt },
  });
  return count;
}

/**
 * Moves rows out of the claim set after their attempts are spent — the DLQ stamp.
 * They stay in the table for an operator to inspect and replay; nothing deletes
 * them, and because they no longer match the partial index's predicate they stop
 * costing the drainer anything.
 */
export async function markFailed(
  db: DbClient,
  ids: readonly string[],
  failedAt: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await db.outboxEvent.updateMany({
    where: { id: { in: ids.map((id) => BigInt(id)) }, publishedAt: null, failedAt: null },
    data: { failedAt },
  });
  return count;
}

/**
 * Stamps every row whose attempts are spent, in one statement — the DLQ sweep.
 *
 * A row that keeps throwing on publish burns an attempt per claim and then falls
 * out of the claim set on its own (the claim filters `attempts < maxAttempts`),
 * but it would still match the partial index forever. This retires it: the
 * predicate stops matching, so the index shrinks back to the real backlog.
 *
 * The drainer runs this BEFORE claiming, which is the ordering crepe's IAP sweep
 * learned the hard way — retire first, then claim, or the last attempt of a row
 * gets claimed and immediately invalidated in the same turn.
 */
export async function failExhausted(
  db: DbClient,
  maxAttempts: number,
  failedAt: Date,
): Promise<number> {
  const { count } = await db.outboxEvent.updateMany({
    where: { publishedAt: null, failedAt: null, attempts: { gte: maxAttempts } },
    data: { failedAt },
  });
  return count;
}

/**
 * Deletes delivered rows older than `before` — retention, the
 * `feature-flag:purge-deleted` analogue. Only `publishedAt IS NOT NULL` rows go:
 * a failed row is evidence and waits for a human.
 */
export async function purgePublished(db: DbClient, before: Date): Promise<number> {
  const { count } = await db.outboxEvent.deleteMany({
    where: { publishedAt: { not: null, lt: before } },
  });
  return count;
}
