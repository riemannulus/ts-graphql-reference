import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostService } from '../../../modules/post/post.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = makeTestPrisma();
const posts = new PostService(prisma);

/** A post needs an author (FK); create one directly to keep these post-focused. */
function makeAuthor() {
  return prisma.user.create({ data: { email: 'author@example.com' } });
}

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('PostService', () => {
  it('creates an unpublished post linked to its author', async () => {
    const author = await makeAuthor();
    const post = await posts.create({ title: 'Hello', content: 'world', authorId: author.id });
    expect(post.title).toBe('Hello');
    expect(post.content).toBe('world');
    expect(post.published).toBe(false);
    expect(post.authorId).toBe(author.id);
  });

  it('defaults content to null when omitted', async () => {
    const author = await makeAuthor();
    const post = await posts.create({ title: 'No body', authorId: author.id });
    expect(post.content).toBeNull();
  });

  it('returns null from findById for a missing post', async () => {
    expect(await posts.findById(999)).toBeNull();
  });

  it('publishes a post; publishing again is idempotent', async () => {
    const author = await makeAuthor();
    const post = await posts.create({ title: 'Draft', authorId: author.id });
    expect((await posts.publish(post.id)).published).toBe(true);
    expect((await posts.publish(post.id)).published).toBe(true);
  });

  it('onlyPublished filters out drafts', async () => {
    const author = await makeAuthor();
    const a = await posts.create({ title: 'a', authorId: author.id });
    await posts.create({ title: 'b', authorId: author.id });
    await posts.publish(a.id);

    expect(await posts.findMany()).toHaveLength(2);
    const published = await posts.findMany({}, { onlyPublished: true });
    expect(published).toHaveLength(1);
    expect(published[0]?.title).toBe('a');
  });
});
