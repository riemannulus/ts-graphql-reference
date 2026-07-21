import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as postRepo from '../../../modules/post/post.repo.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();

/** A post needs an author (FK); create one directly to keep these post-focused. */
function makeAuthor() {
  return prisma.user.create({ data: { email: 'author@example.com' } });
}

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('post repo', () => {
  it('creates an unpublished post linked to its author', async () => {
    const author = await makeAuthor();
    const post = await postRepo.createPost(prisma, {
      title: 'Hello',
      content: 'world',
      authorId: author.id,
    });
    expect(post.title).toBe('Hello');
    expect(post.content).toBe('world');
    expect(post.published).toBe(false);
    expect(post.authorId).toBe(author.id);
  });

  it('defaults content to null when omitted', async () => {
    const author = await makeAuthor();
    const post = await postRepo.createPost(prisma, { title: 'No body', authorId: author.id });
    expect(post.content).toBeNull();
  });

  it('returns null from findById for a missing post', async () => {
    expect(await postRepo.findById(prisma, 999)).toBeNull();
  });

  it('publishes a post; publishing again is idempotent', async () => {
    const author = await makeAuthor();
    const post = await postRepo.createPost(prisma, { title: 'Draft', authorId: author.id });
    expect((await postRepo.publishPost(prisma, post.id)).published).toBe(true);
    expect((await postRepo.publishPost(prisma, post.id)).published).toBe(true);
  });

  it('onlyPublished filters out drafts', async () => {
    const author = await makeAuthor();
    const a = await postRepo.createPost(prisma, { title: 'a', authorId: author.id });
    await postRepo.createPost(prisma, { title: 'b', authorId: author.id });
    await postRepo.publishPost(prisma, a.id);

    expect(await postRepo.findMany(prisma)).toHaveLength(2);
    const published = await postRepo.findMany(prisma, {}, { onlyPublished: true });
    expect(published).toHaveLength(1);
    expect(published[0]?.title).toBe('a');
  });

  it('createPost participates in a passed transaction and rolls back with it', async () => {
    const author = await makeAuthor();
    await expect(
      prisma.$transaction(async (tx) => {
        await postRepo.createPost(tx, { title: 'tx', authorId: author.id });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.post.count()).toBe(0);
  });

  describe('findByIds (external-key hydration)', () => {
    it('returns rows in the given order, not the database order', async () => {
      const author = await makeAuthor();
      const a = await postRepo.createPost(prisma, { title: 'a', authorId: author.id });
      const b = await postRepo.createPost(prisma, { title: 'b', authorId: author.id });
      const c = await postRepo.createPost(prisma, { title: 'c', authorId: author.id });

      const ranked = [c.id, a.id, b.id];
      const rows = await postRepo.findByIds(prisma, ranked);
      expect(rows.map((r) => r.id)).toEqual(ranked);
    });

    it('skips ids the database no longer has (index drift)', async () => {
      const author = await makeAuthor();
      const a = await postRepo.createPost(prisma, { title: 'a', authorId: author.id });

      const rows = await postRepo.findByIds(prisma, [a.id, 9999]);
      expect(rows.map((r) => r.id)).toEqual([a.id]); // the missing id is dropped, not null
    });

    it('preserves order even when the selection omits id (select forces it back)', async () => {
      const author = await makeAuthor();
      const a = await postRepo.createPost(prisma, { title: 'a', authorId: author.id });
      const b = await postRepo.createPost(prisma, { title: 'b', authorId: author.id });

      // Mimic a Pothos `query` that selected only `title` (no id).
      const rows = await postRepo.findByIds(prisma, [b.id, a.id], { select: { title: true } });
      expect(rows.map((r) => r.title)).toEqual(['b', 'a']);
    });

    it('returns [] for an empty id list without querying nonsense', async () => {
      expect(await postRepo.findByIds(prisma, [])).toEqual([]);
    });
  });
});
