import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOnboardingService } from '../../../modules/onboarding/onboarding.service.js';
import { fakeFlagReader } from '../../support/flag-reader-fake.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };
const onboarding = createOnboardingService({ db });

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('onboarding register', () => {
  it('creates the user and a welcome post authored by them', async () => {
    const user = await onboarding.register({ email: 'alice@example.com', name: 'Alice' }, fakeFlagReader());

    expect(user.email).toBe('alice@example.com');

    const userPosts = await prisma.post.findMany({ where: { authorId: user.id } });
    expect(userPosts).toHaveLength(1);
    expect(userPosts[0]?.title).toBe('Welcome!'); // classic — the default variant
    expect(userPosts[0]?.content).toContain('Alice');
  });

  it('picks the welcome-post copy from the welcomeVariant flag (implementation swap)', async () => {
    const user = await onboarding.register(
      { email: 'fest@example.com', name: 'Fest' },
      fakeFlagReader({ welcomeVariant: 'festive' }),
    );
    const post = await prisma.post.findFirstOrThrow({ where: { authorId: user.id } });
    expect(post.title).toBe('🎉 Welcome aboard!');
    expect(post.content).toContain('Fest');
  });

  it('rolls back the user when welcome-post creation fails', async () => {
    // Inject a post writer that always throws, so the transaction aborts.
    const failing = createOnboardingService({
      db,
      createPost: () => Promise.reject(new Error('post failed')),
    });

    await expect(failing.register({ email: 'bob@example.com' }, fakeFlagReader())).rejects.toThrow(
      'post failed',
    );

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.post.count()).toBe(0);
  });
});
