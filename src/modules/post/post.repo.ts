import type { Post, Prisma } from '@prisma/client';
import type { DbClient } from '../../db/db.js';

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
  db: DbClient,
  id: number,
  query: Prisma.PostDefaultArgs = {},
): Promise<Post | null> {
  return db.post.findUnique({ ...query, where: { id } });
}

export function findMany(
  db: DbClient,
  query: Prisma.PostFindManyArgs = {},
  opts: { onlyPublished?: boolean } = {},
): Promise<Post[]> {
  return db.post.findMany({
    orderBy: { createdAt: 'desc' },
    ...query,
    ...(opts.onlyPublished ? { where: { published: true } } : {}),
  });
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
