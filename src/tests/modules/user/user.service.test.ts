import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUserService } from '../../../modules/user/user.service.js';
import * as userRepo from '../../../modules/user/user.repo.js';
import { InvalidStatusTransitionError } from '../../../modules/user/user.state.js';
import { EmailAlreadyRegisteredError, parseEmail } from '../../../modules/user/user.value.js';
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

  it('surfaces a duplicate email as the expected domain error', async () => {
    await users.create({ email: 'taken@example.com' });
    await expect(users.create({ email: 'taken@example.com' })).rejects.toBeInstanceOf(
      EmailAlreadyRegisteredError,
    );
  });
});

describe('user repo', () => {
  it('CAS transition lands only when the row still holds the status the decision saw', async () => {
    const user = await users.create({ email: 'cas@example.com' });

    // The guard the service relies on: writing SUSPENDED assuming ACTIVE…
    const landed = await userRepo.transitionStatus(prisma, user.id, 'ACTIVE', 'SUSPENDED');
    expect(landed?.status).toBe('SUSPENDED');

    // …misses when the assumed status is stale (a concurrent transition won).
    expect(await userRepo.transitionStatus(prisma, user.id, 'ACTIVE', 'DEACTIVATED')).toBeNull();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.status).toBe('SUSPENDED');
  });

  it('createUser participates in a passed transaction and rolls back with it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await userRepo.createUser(tx, { email: parseEmail('tx@example.com'), name: null });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(0);
  });

  it('writes already-parsed domain values (email normalized at the boundary)', async () => {
    const created = await userRepo.createUser(prisma, {
      email: parseEmail('  Mixed@Case.COM '),
      name: null,
    });
    expect(created.email).toBe('mixed@case.com');
  });
});
