import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUserService } from '../../../modules/user/user.service.js';
import * as userRepo from '../../../modules/user/user.repo.js';
import { InvalidStatusTransitionError } from '../../../modules/user/user.state.js';
import { parseEmail } from '../../../modules/user/user.value.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const users = createUserService({ rw: prisma, ro: prisma });

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('user service', () => {
  it('creates a user with default ACTIVE status', async () => {
    const user = await users.create({ email: 'a@b.com', name: 'Alice' });
    expect(user.email).toBe('a@b.com');
    expect(user.status).toBe('ACTIVE');
  });

  it('changes status along a legal path', async () => {
    const user = await users.create({ email: 'a@b.com' });
    const suspended = await users.changeStatus(user.id, 'SUSPENDED');
    expect(suspended.status).toBe('SUSPENDED');
  });

  it('rejects an illegal status transition', async () => {
    const user = await users.create({ email: 'a@b.com' });
    await users.changeStatus(user.id, 'DEACTIVATED');
    await expect(users.changeStatus(user.id, 'ACTIVE')).rejects.toBeInstanceOf(
      InvalidStatusTransitionError,
    );
  });

  it('create participates in a passed transaction and rolls back with it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await users.create({ email: 'tx@example.com' }, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('user repo CAS transition', () => {
  it('lands only when the row still holds the status the decision saw', async () => {
    const user = await users.create({ email: 'cas@example.com' });

    // The guard the service relies on: writing SUSPENDED assuming ACTIVE…
    expect(await userRepo.transitionStatus(prisma, user.id, 'ACTIVE', 'SUSPENDED')).toBe(true);

    // …misses when the assumed status is stale (a concurrent transition won).
    expect(await userRepo.transitionStatus(prisma, user.id, 'ACTIVE', 'DEACTIVATED')).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.status).toBe('SUSPENDED');
  });

  it('writes already-parsed domain values (email normalized at the boundary)', async () => {
    const created = await userRepo.createUser(prisma, {
      email: parseEmail('  Mixed@Case.COM '),
      name: null,
    });
    expect(created.email).toBe('mixed@case.com');
  });
});
