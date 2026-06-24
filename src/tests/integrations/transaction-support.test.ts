import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Guards a load-bearing assumption: the PGlite driver adapter must support
// Prisma interactive transactions so onboarding can create a user + welcome
// post atomically (see OnboardingService).
const prisma = await makeTestPrisma();

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('PGlite interactive transactions', () => {
  it('commits when the callback succeeds', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { email: 'commit@example.com' } });
    });
    expect(await prisma.user.count()).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { email: 'rollback@example.com' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(0);
  });
});
