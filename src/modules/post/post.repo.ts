import type { Post, Prisma } from '@prisma/client';
import type { DbClient, ReadDbClient } from '../../db/db.js';

/**
 * Post persistence. The post module carries no domain decisions (no state
 * machine, no value objects, no cross-row invariants), so it has NO core and
 * NO service — the graduation rule from CONVENTIONS.md: a module earns a
 * `*.core.ts`/`*.service.ts` when its first real decision appears, not before.
 * Resolvers call these functions directly on the routed selection client.
 */

export interface CreatePostInput {
  title: string;
  content?: string | null;
  authorId: number;
}

export function findById(
  db: ReadDbClient,
  id: number,
  query: Prisma.PostDefaultArgs = {},
): Promise<Post | null> {
  return db.post.findUnique({ ...query, where: { id } });
}

export function findMany(
  db: ReadDbClient,
  query: Prisma.PostFindManyArgs = {},
  opts: { onlyPublished?: boolean } = {},
): Promise<Post[]> {
  return db.post.findMany({
    orderBy: { createdAt: 'desc' },
    ...query,
    ...(opts.onlyPublished ? { where: { published: true } } : {}),
  });
}

/**
 * Hydrates posts for a list of ids coming from OUTSIDE the database (a search
 * index), preserving the given order — the hydration half of the "external key
 * → DB row" pattern (see modules/search/). Two decisions live here, in the only
 * layer that talks Prisma:
 *
 * - **Order.** `WHERE id IN (...)` returns rows in an arbitrary order, so the
 *   result is re-sorted to match the input `ids` (the index's rank order).
 * - **Drift.** A search index is eventually consistent: an id it still returns
 *   may have been deleted from the database. Such ids are skipped, not surfaced
 *   as nulls — the caller asked for posts, and a vanished one simply isn't one.
 */
export async function findByIds(
  db: ReadDbClient,
  ids: number[],
  query: Prisma.PostDefaultArgs = {},
): Promise<Post[]> {
  // A `select` projection may omit `id` (the client didn't ask for it), but the
  // reorder below needs it; `include` keeps all scalars, so id is already there.
  const args = query.select ? { ...query, select: { ...query.select, id: true } } : query;
  const rows = await db.post.findMany({ ...args, where: { id: { in: ids } } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is Post => row !== undefined);
}

export function createPost(
  db: DbClient,
  input: CreatePostInput,
  query: Prisma.PostDefaultArgs = {},
): Promise<Post> {
  return db.post.create({
    ...query,
    data: {
      title: input.title,
      content: input.content ?? null,
      author: { connect: { id: input.authorId } },
    },
  });
}

export function publishPost(
  db: DbClient,
  id: number,
  query: Prisma.PostDefaultArgs = {},
): Promise<Post> {
  return db.post.update({ ...query, where: { id }, data: { published: true } });
}
