import type { Prisma } from '@prisma/client';
import type { DbClient } from '../db/db.js';

/**
 * Persistence for the transactional outbox (delivery ladder rung 1).
 *
 * Like every repo here, it never picks a client: the caller passes the handle,
 * which is how `enqueue` joins the SAME transaction as the domain write — that
 * shared transaction IS the guarantee the rung buys.
 *
 * TWO boundary conversions happen in this file and nowhere else:
 *
 * - **`BigInt` never escapes.** `OutboxEvent.id` is the only `BigInt` in the
 *   schema, and `JSON.stringify` THROWS on a JS `bigint` — one logged row would
 *   take down a drain. Ids leave here as `string` and come back as `string`; the
 *   `BigInt(...)` conversions are confined to the two statements below.
 * - **`payload` is parsed, not trusted.** It is a `Json` column, so it reads back
 *   as `Prisma.JsonValue`; the drainer receives `unknown` and the topic's own
 *   codec decides what it is (CONVENTIONS §4, parse don't validate).
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
 * Claims a batch of pending rows and counts the attempt, atomically.
 *
 * `FOR UPDATE SKIP LOCKED` is the concurrency ladder's **rung 4** — "row lock /
 * queue claim … claim specific rows (e.g. a worker queue)", which CONVENTIONS §1
 * allocates to the REPO. (The neighbouring rule that raw lock SQL may live only
 * in `uow.ts` governs ADVISORY locks — it sits under the heading "Advisory locks
 * are the escape hatch, not the default" and its sibling bullets are about
 * `orderLocks` and the key registry. A row lock is a different rung with a
 * different home.) It is the first raw query in a repo in this codebase, hence
 * the length of this comment.
 *
 * SKIP LOCKED is what lets several drainers run without coordinating: each takes
 * rows the others have not locked, and none blocks. The cost is that global
 * ordering is NOT preserved — which the outbox can afford only because payloads
 * are ids and the resolver re-fetches, so reordering and duplication are both
 * unobservable (the five laws).
 *
 * The attempt is counted HERE, inside the claim, rather than after a failed
 * publish: the publish happens outside any transaction (see `outbox.ts`), so a
 * crash between the two must still burn an attempt or a poison row would be
 * retried forever.
 *
 * Every projected column is cast explicitly. Raw rows come back driver-typed, not
 * Prisma-mapped, and this repo runs two different drivers (`@prisma/adapter-pg`
 * in production, `pglite-prisma-adapter` in tests) — `"id"::text` and
 * `"payload"::text` make the shape identical under both instead of trusting each
 * driver's coercion. It is the same discipline as the `classid::int` casts in
 * `tests/integrations/concurrency.test.ts`.
 */
export async function claimPending(
  db: DbClient,
  options: ClaimOptions,
): Promise<ClaimedOutboxEvent[]> {
  const rows = await db.$queryRaw<Array<{ id: string; topic: string; key: string; payload: string }>>`
    SELECT "id"::text AS "id", "topic", "key", "payload"::text AS "payload"
    FROM "OutboxEvent"
    WHERE "publishedAt" IS NULL
      AND "failedAt" IS NULL
      AND "attempts" < ${options.maxAttempts}
    ORDER BY "id"
    FOR UPDATE SKIP LOCKED
    LIMIT ${options.limit}
  `;
  if (rows.length === 0) return [];

  await db.outboxEvent.updateMany({
    where: { id: { in: rows.map((row) => BigInt(row.id)) } },
    data: { attempts: { increment: 1 } },
  });

  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    key: row.key,
    // The column is JSONB, so this always parses; a throw here would mean the
    // column was written by something that bypassed the delegate.
    payload: JSON.parse(row.payload) as unknown,
  }));
}

/**
 * Marks rows delivered. `publishedAt` arrives as a parameter — a repo never mints
 * a decision instant, the service reads it from the injected clock once
 * (CONVENTIONS §10 rule 1). Returns how many rows moved, which the drainer logs.
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
