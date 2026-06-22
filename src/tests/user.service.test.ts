import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { UserService } from '../modules/user/user.service.js';
import { InvalidStatusTransitionError } from '../modules/user/user.state.js';
import { makeTestPrisma, resetDb } from './helpers.js';

const prisma = makeTestPrisma();
const users = new UserService(prisma);

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('UserService', () => {
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
});
