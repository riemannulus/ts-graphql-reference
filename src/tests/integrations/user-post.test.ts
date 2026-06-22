import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostService } from '../../modules/post/post.service.js';
import { UserService } from '../../modules/user/user.service.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Cross-module integration: the user and post services working together against
// a real database, with no GraphQL/HTTP layer (that path is covered in e2e/).
// The integration point is the User←Post relation: a post created by PostService
// must connect to a user created by UserService.
const prisma = await makeTestPrisma();
const users = new UserService(prisma);
const posts = new PostService(prisma);

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('user → post integration', () => {
  it('creates a user, then a post authored by them, and persists the relation both ways', async () => {
    const author = await users.create({ email: 'alice@example.com', name: 'Alice' });
    const post = await posts.create({ title: 'First post', content: 'hello', authorId: author.id });

    expect(post.authorId).toBe(author.id);

    // The post is reachable from the user side…
    const withPosts = await prisma.user.findUniqueOrThrow({
      where: { id: author.id },
      include: { posts: true },
    });
    expect(withPosts.posts).toHaveLength(1);
    expect(withPosts.posts[0]?.title).toBe('First post');

    // …and the post resolves back to the same author.
    const withAuthor = await prisma.post.findUniqueOrThrow({
      where: { id: post.id },
      include: { author: true },
    });
    expect(withAuthor.author.id).toBe(author.id);
    expect(withAuthor.author.email).toBe('alice@example.com');
  });

  it('rejects a post for a non-existent author (FK enforced)', async () => {
    await expect(posts.create({ title: 'orphan', authorId: 999 })).rejects.toThrow();
  });

  it('a published post by the user shows up under onlyPublished', async () => {
    const author = await users.create({ email: 'bob@example.com' });
    const draft = await posts.create({ title: 'Draft', authorId: author.id });

    expect(await posts.findMany({}, { onlyPublished: true })).toHaveLength(0);

    await posts.publish(draft.id);
    const published = await posts.findMany({}, { onlyPublished: true });
    expect(published).toHaveLength(1);
    expect(published[0]?.authorId).toBe(author.id);
  });
});
