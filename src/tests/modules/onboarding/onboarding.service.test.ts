import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service.js';
import { PostService } from '../../../modules/post/post.service.js';
import { UserService } from '../../../modules/user/user.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const users = new UserService(prisma);
const posts = new PostService(prisma);
const onboarding = new OnboardingService({ users, posts, prisma });

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('OnboardingService.register', () => {
  it('creates the user and a welcome post authored by them', async () => {
    const user = await onboarding.register({ email: 'alice@example.com', name: 'Alice' });

    expect(user.email).toBe('alice@example.com');

    const userPosts = await prisma.post.findMany({ where: { authorId: user.id } });
    expect(userPosts).toHaveLength(1);
    expect(userPosts[0]?.title).toBe('Welcome!');
    expect(userPosts[0]?.content).toContain('Alice');
  });

  it('rolls back the user when welcome-post creation fails', async () => {
    // Inject a PostService whose create always throws, so the transaction aborts.
    const failingPosts = {
      create: () => Promise.reject(new Error('post failed')),
    } as unknown as PostService;
    const failing = new OnboardingService({ users, posts: failingPosts, prisma });

    await expect(failing.register({ email: 'bob@example.com' })).rejects.toThrow('post failed');

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.post.count()).toBe(0);
  });
});
