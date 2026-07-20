import type { Prisma, PrismaClient } from '@prisma/client';
import { createPrismaClient } from './prisma.js';

/**
 * The two database handles of the app.
 *
 * - `rw` — the primary. All writes, every transaction, and every read whose
 *   result feeds a *decision* (a use-case must never decide on replica-lagged
 *   state) or that must see the caller's own writes.
 * - `ro` — a read replica for plain query-path reads (projections). May lag
 *   behind the primary; never used inside a use-case.
 *
 * When no replica is configured (`READONLY_DATABASE_URL` unset — dev, small
 * deployments), `ro` IS `rw`: the routing rules still hold, they just route to
 * the same server.
 */
export interface Db {
  rw: PrismaClient;
  ro: PrismaClient;
}

/**
 * Any client a repo function can run on: the `rw`/`ro` client or a transaction
 * handle. Repo functions take this as their first parameter and never choose a
 * client themselves — WHERE a statement runs (primary, replica, inside which
 * transaction) is always the caller's decision.
 */
export type DbClient = Prisma.TransactionClient;

/** The model-delegate methods that only read. */
type ReadMethod =
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findMany'
  | 'count'
  | 'aggregate'
  | 'groupBy';

/**
 * The read-projection subset of `DbClient`: every model delegate, but only its
 * read methods — no writes, no `$`-methods (raw SQL can write), no
 * transactions. This is what the query path provides (`ctx.read`) and what repo
 * READ functions accept, so "the query path never writes" is a compile-time
 * fact, not a convention: a repo write function cannot even be called with a
 * `ReadDbClient`.
 *
 * Structural typing does the wiring: `PrismaClient` and a transaction handle
 * both satisfy this type (so services can run repo reads on their `tx`), while
 * nothing satisfies `DbClient` through it.
 */
export type ReadDbClient = {
  [K in keyof DbClient as DbClient[K] extends { findMany: (...args: never) => unknown }
    ? K
    : never]: Pick<DbClient[K], Extract<keyof DbClient[K], ReadMethod>>;
};

export function createDb(): Db {
  const rwUrl = process.env.DATABASE_URL;
  const roUrl = process.env.READONLY_DATABASE_URL;
  if (roUrl && !rwUrl) {
    // A replica with no primary is a misconfiguration; failing beats silently
    // pointing rw at the built-in dev default while ro goes elsewhere.
    throw new Error('READONLY_DATABASE_URL is set but DATABASE_URL is not');
  }
  const rw = createPrismaClient(rwUrl);
  const ro = roUrl && roUrl !== rwUrl ? createPrismaClient(roUrl) : rw;
  return { rw, ro };
}

/** Disconnects both handles (once, when they are the same client). */
export async function disconnectDb(db: Db): Promise<void> {
  await db.rw.$disconnect();
  if (db.ro !== db.rw) {
    await db.ro.$disconnect();
  }
}
