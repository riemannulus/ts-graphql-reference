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
        VALUES (${userId}, 'REFUNDED', 10, 0, 10, 0)`,
    ).rejects.toThrow(/PointCharge_state_check/);
  });

  it('accepts the EXPIRED charge state (added to POINT_CHARGE_STATES for point expiry)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "state", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount", "expiredAt")
        VALUES (${userId}, 'EXPIRED', 10, 0, 0, 0, CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
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

  it('rejects an out-of-set feature-flag stage (in sync with STAGES)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('f', 'STAGING', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_stage_check/);
  });

  it('accepts a NULL stage and every known stage', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('none', NULL, CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
    await Promise.all(
      ['LOCAL', 'DEV', 'QA', 'STG', 'PROD'].map((stage) =>
        expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt") VALUES ('flag_${stage}', '${stage}', CURRENT_TIMESTAMP)`,
          ),
        ).resolves.toBe(1),
      ),
    );
  });

  it('rejects a feature-flag window that ends before it starts', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "enableAfter", "disableAfter", "updatedAt")
        VALUES ('f', 'PROD', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_window_check/);
  });

  it('accepts an equal-bounds feature-flag window (the bound is inclusive)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "enableAfter", "disableAfter", "updatedAt")
        VALUES ('eq', 'PROD', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
  });

  it('rejects a second LIVE row of the same name (one live flag per name)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('dup', 'PROD', CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('dup', 'DEV', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_name_live_key/);
  });

  it('rejects a negative outbox attempt count', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "OutboxEvent" ("topic", "key", "payload", "attempts")
        VALUES ('pointBalanceChanged', '1', '{}', -1)`,
    ).rejects.toThrow(/OutboxEvent_attempts_check/);
  });

  it('accepts a zero outbox attempt count (the freshly enqueued row)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "OutboxEvent" ("topic", "key", "payload", "attempts")
        VALUES ('pointBalanceChanged', '1', '{}', 0)`,
    ).resolves.toBe(1);
  });

  it('rejects a duplicate session access token (one row per credential)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "Session" ("id", "accessToken", "userId", "expiresAt")
        VALUES ('sess-1', 'tok', ${userId}, '2026-01-01T00:00:00Z')`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`INSERT INTO "Session" ("id", "accessToken", "userId", "expiresAt")
        VALUES ('sess-2', 'tok', ${userId}, '2026-01-01T00:00:00Z')`,
    ).rejects.toThrow(/Session_accessToken_key/);
  });
});
