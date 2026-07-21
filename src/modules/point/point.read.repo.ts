import type { ReadDbClient, Selection } from '../../db/db.js';

/**
 * Point persistence, read path — projections for the GraphQL query layer.
 * These grow one-per-field as the schema grows, and every function has the
 * same mechanical shape: accept the Pothos `query` object (`select`/
 * `include`) and spread it, so the plugin's relation-loading optimization
 * survives. The `query` parameter STOPS at this layer: it is Prisma-shaped
 * (a translation of the GraphQL selection), so the repo is where it belongs —
 * services never see it.
 *
 * Everything here takes `ReadDbClient` (write methods stripped at the type
 * level) — reads that feed a WRITE decision live with their executors in
 * point.write.repo.ts instead (e.g. `loadSpendWorld`).
 */

export function findBalance(
  db: ReadDbClient,
  userId: number,
  query: Selection<'PointBalance'> = {},
) {
  return db.pointBalance.findUnique({ ...query, where: { userId } });
}

export function findCharges(
  db: ReadDbClient,
  userId: number,
  query: Selection<'PointCharge'> = {},
) {
  return db.pointCharge.findMany({
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
    ...query,
    where: { userId },
  });
}

export function findSpends(
  db: ReadDbClient,
  userId: number,
  query: Selection<'PointSpend'> = {},
) {
  return db.pointSpend.findMany({
    orderBy: { createdAt: 'desc' },
    ...query,
    where: { userId },
  });
}

export function getChargeById(
  db: ReadDbClient,
  id: number,
  query: Selection<'PointCharge'> = {},
) {
  return db.pointCharge.findUniqueOrThrow({ ...query, where: { id } });
}

export function getSpendById(
  db: ReadDbClient,
  id: number,
  query: Selection<'PointSpend'> = {},
) {
  return db.pointSpend.findUniqueOrThrow({ ...query, where: { id } });
}
