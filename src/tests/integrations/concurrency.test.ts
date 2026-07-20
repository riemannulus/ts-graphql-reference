import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lockKey } from '../../db/locks.js';
import { uow } from '../../db/uow.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// The concurrency toolkit against the real (PGlite) database. PGlite is
// single-connection, so true contention (a second transaction blocking on a
// held lock, or trySerialized failing to acquire) cannot be exercised here —
// that half is covered structurally. What IS checked: each rung opens the right
// kind of transaction and, for the lock rungs, actually issues the advisory
// locks (visible in pg_locks) rather than silently doing nothing.
const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('uow.run', () => {
  it('commits on success and rolls back on throw', async () => {
    await uow.run(db, (tx) => tx.user.create({ data: { email: 'commit@x.com' } }));
    expect(await prisma.user.count()).toBe(1);

    await expect(
      uow.run(db, async (tx) => {
        await tx.user.create({ data: { email: 'rollback@x.com' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(1); // the second write rolled back
  });
});

describe('uow.snapshot', () => {
  it('runs the body at REPEATABLE READ', async () => {
    const level = await uow.snapshot(db, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ level: string }>>`
        SELECT current_setting('transaction_isolation') AS level
      `;
      return rows[0]?.level;
    });
    expect(level).toBe('repeatable read');
  });
});

describe('uow.serialized', () => {
  it('acquires a transaction-scoped advisory lock for each key', async () => {
    const key = lockKey.pointBalance(7);
    const locks = await uow.serialized(db, [key], async (tx) => {
      return tx.$queryRaw<Array<{ classid: number; objid: number }>>`
        SELECT classid::int AS classid, objid::int AS objid
        FROM pg_locks WHERE locktype = 'advisory'
      `;
    });
    expect(locks).toContainEqual({ classid: key.ns, objid: key.obj });
  });

  it('runs the body and returns its result', async () => {
    const user = await uow.serialized(db, [lockKey.pointBalance(1)], (tx) =>
      tx.user.create({ data: { email: 'locked@x.com' } }),
    );
    expect(user.email).toBe('locked@x.com');
  });
});

describe('uow.trySerialized', () => {
  it('acquires when uncontended and runs the body', async () => {
    const result = await uow.trySerialized(db, [lockKey.pointBalance(9)], async () => 'done');
    expect(result).toEqual({ acquired: true, result: 'done' });
  });
});
