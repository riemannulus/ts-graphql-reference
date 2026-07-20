import type { Db, DbClient } from './db.js';
import { ConcurrentUpdateError } from './errors.js';
import { type LockKey, orderLocks } from './locks.js';
import { isSerializationConflict } from './prisma-errors.js';

/**
 * Unit of work — the sanctioned way to open a transaction, and the four rungs
 * of the concurrency ladder as one small interface (see CONVENTIONS
 * "Concurrency: the ladder"). A use-case picks a rung by intent; the mechanism
 * (isolation level, lock acquisition, error translation) is hidden here so the
 * service body stays a plain read → decide → execute.
 *
 * Every rung runs on the PRIMARY (`db.rw`) — a use-case decides on the state it
 * writes against — and funnels through one internal `runTx`, so a lost race
 * fails the SAME way everywhere: a serialization failure (Postgres `P2034`,
 * possible only under snapshot isolation) becomes a retryable
 * `ConcurrentUpdateError` (`CONFLICT`), matching the optimistic guards a repo
 * raises. Callers handle one failure mode regardless of which rung they used.
 */

/** Options forwarded to Prisma's interactive transaction. */
export interface TxOptions {
  /** Max ms the body may run before Prisma aborts the transaction. */
  timeout?: number;
  /** Max ms to wait for a connection before failing. */
  maxWait?: number;
}

/** Extra options for the lock rungs. */
export interface SerializedOptions extends TxOptions {
  /**
   * Run the locked section at REPEATABLE READ (see `snapshot`). Set this when
   * the body ALSO reads rows that lock-free operations may still mutate — e.g. a
   * transfer whose sender ledger a plain `spend` can touch. Default: the
   * Postgres default (READ COMMITTED), since the advisory lock already
   * serializes writers of these keys.
   */
  snapshot?: boolean;
}

type Body<T> = (tx: DbClient) => Promise<T>;

/**
 * Raises the transaction to REPEATABLE READ, as its FIRST statement.
 *
 * Deliberately SQL, not Prisma's `isolationLevel` transaction option: the
 * production adapter (`@prisma/adapter-pg`) honors that option, but the test
 * adapter (`pglite-prisma-adapter`) silently drops it — relying on it would run
 * `snapshot` at READ COMMITTED in tests, an invisible prod/test gap. `SET
 * TRANSACTION` is transaction-scoped (pool-safe) and works on both, so the rung
 * behaves — and is testable — identically everywhere.
 */
function beginSnapshot(tx: DbClient): Promise<unknown> {
  return tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
}

/**
 * Acquires the advisory locks in the global order, blocking until each is held;
 * they release when the transaction ends. This and `beginSnapshot` are the
 * toolkit's only raw transaction/lock SQL — `locks.ts` stays pure (the key
 * registry and the `orderLocks` law), so a service reaches locks only through
 * `serialized` / `trySerialized`.
 */
async function acquire(tx: DbClient, keys: readonly LockKey[]): Promise<void> {
  for (const key of orderLocks(keys)) {
    // eslint-disable-next-line no-await-in-loop -- ordered acquisition on one tx handle
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key.ns}, ${key.obj})`;
  }
}

/** Non-blocking `acquire`: returns false the moment a key is unavailable. */
async function tryAcquire(tx: DbClient, keys: readonly LockKey[]): Promise<boolean> {
  for (const key of orderLocks(keys)) {
    // eslint-disable-next-line no-await-in-loop -- ordered acquisition on one tx handle
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${key.ns}, ${key.obj}) AS locked
    `;
    if (!rows[0]?.locked) return false;
  }
  return true;
}

async function runTx<T>(db: Db, body: Body<T>, options: TxOptions = {}): Promise<T> {
  try {
    return await db.rw.$transaction(body, options);
  } catch (error) {
    if (isSerializationConflict(error)) {
      throw new ConcurrentUpdateError('the transaction');
    }
    throw error;
  }
}

/**
 * Level 0–1 — a plain atomic transaction. Use when a single statement (a guarded
 * CAS, a unique constraint, an atomic `increment`) already protects the
 * invariant and the transaction only bundles the writes to commit or roll back
 * together.
 */
function run<T>(db: Db, body: Body<T>, options: TxOptions = {}): Promise<T> {
  return runTx(db, body, options);
}

/**
 * Level 2–3 — snapshot isolation. Runs the body at REPEATABLE READ so every read
 * inside sees ONE consistent snapshot: a decision that reads several rows can
 * never straddle a concurrent commit. A lost race (a missed optimistic guard or
 * a serialization failure) surfaces as a retryable `CONFLICT`.
 */
function snapshot<T>(db: Db, body: Body<T>, options: TxOptions = {}): Promise<T> {
  return runTx(
    db,
    async (tx) => {
      await beginSnapshot(tx);
      return body(tx);
    },
    options,
  );
}

/**
 * Level 5 — advisory-lock serialization. Acquires every key at the TOP of the
 * transaction, in the global order (deadlock-free — see `orderLocks`), then runs
 * the body; the locks release when the transaction ends. The escape hatch:
 * prefer the lower rungs, and note that a lock serializes only against writers
 * that take the SAME key — mixing a lock with lock-free writers of the same rows
 * protects nothing on its own.
 */
function serialized<T>(
  db: Db,
  keys: readonly LockKey[],
  body: Body<T>,
  options: SerializedOptions = {},
): Promise<T> {
  const { snapshot: asSnapshot, ...tx } = options;
  return runTx(
    db,
    async (client) => {
      if (asSnapshot) await beginSnapshot(client);
      await acquire(client, keys);
      return body(client);
    },
    tx,
  );
}

/** Outcome of `trySerialized`: the body ran, or the locks were unavailable. */
export type TryResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Non-blocking Level 5 — like `serialized`, but if any key is already held it
 * does NO work and returns `{ acquired: false }` instead of queueing. For
 * periodic jobs that should yield to (and retry after) a contending operation
 * rather than pile up behind it.
 */
function trySerialized<T>(
  db: Db,
  keys: readonly LockKey[],
  body: Body<T>,
  options: SerializedOptions = {},
): Promise<TryResult<T>> {
  const { snapshot: asSnapshot, ...tx } = options;
  return runTx(
    db,
    async (client): Promise<TryResult<T>> => {
      if (asSnapshot) await beginSnapshot(client);
      if (!(await tryAcquire(client, keys))) return { acquired: false };
      return { acquired: true, result: await body(client) };
    },
    tx,
  );
}

/** The concurrency toolkit — import this, not the individual functions. */
export const uow = { run, snapshot, serialized, trySerialized };
