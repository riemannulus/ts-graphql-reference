import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// The DB-side halves of invariants whose other half lives in code. The code
// keeps the single source of truth for *rules* (transitions, plans); these
// CHECK constraints guarantee the *value sets and signs* survive even a buggy
// or bypassing writer. Raw SQL is used on purpose — the point is that the
// database itself refuses, with no application layer in the way.
const prisma = await makeTestPrisma();

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function makeUser(): Promise<number> {
  const user = await prisma.user.create({ data: { email: 'checks@example.com' } });
  return user.id;
}

describe('database CHECK constraints', () => {
  it('rejects an out-of-set user status (in sync with USER_STATUSES)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "User" ("email", "status", "updatedAt")
        VALUES ('bad@example.com', 'CORRUPTED', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/User_status_check/);
  });

  it('rejects an out-of-set point charge state (in sync with POINT_CHARGE_STATES)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "state", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 'EXPIRED', 10, 0, 10, 0)`,
    ).rejects.toThrow(/PointCharge_state_check/);
  });

  it('rejects a negative unspent amount on a charge (no persistable overdraft)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 10, 0, -1, 0)`,
    ).rejects.toThrow(/PointCharge_unspentPaidAmount_check/);
  });

  it('rejects a negative balance', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointBalance"
        ("userId", "paidAmount", "freeAmount", "totalAmount", "updatedAt")
        VALUES (${userId}, -1, 0, 0, CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/PointBalance_paidAmount_check/);
  });

  it('rejects an unspent remainder larger than what was charged (no inflation)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 10, 0, 11, 0)`,
    ).rejects.toThrow(/PointCharge_unspentPaidAmount_check/);
  });

  it('rejects a spend whose total does not equal paid + free', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointSpend"
        ("userId", "paidAmount", "freeAmount", "totalAmount", "reason")
        VALUES (${userId}, 10, 5, 14, 'inconsistent')`,
    ).rejects.toThrow(/PointSpend_totalAmount_check/);
  });
});
