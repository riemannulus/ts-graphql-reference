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
});

// The ledger's shape, guarded by the database rather than by the kernel that
// normally writes it. The kernel is the source of truth for the RULES; these
// constraints are what still holds when a migration, a console session or a
// future writer goes around it — which for money is the case that matters.
describe('ledger CHECK constraints', () => {
  /** An OPEN flow to hang holders, lots and events off. */
  async function makeReference(id: string, kind = 'ORDER'): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LedgerReference" ("id", "kind", "openedAt") VALUES ('${id}', '${kind}', CURRENT_TIMESTAMP)`,
    );
    return id;
  }

  it('rejects an out-of-set reference kind (in sync with REFERENCE_KINDS)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LedgerReference" ("id", "kind", "openedAt")
        VALUES ('XX-0000000001', 'BARTER', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/LedgerReference_kind_check/);
  });

  it('rejects a CLOSED flow with no reason for being closed', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LedgerReference" ("id", "kind", "state", "closedAt", "openedAt")
        VALUES ('OR-0000000002', 'ORDER', 'CLOSED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/LedgerReference_closed_shape_check/);
  });

  it('rejects an OPEN flow that claims to have settled', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LedgerReference" ("id", "kind", "state", "closeReason", "openedAt")
        VALUES ('OR-0000000003', 'ORDER', 'OPEN', 'SETTLED', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/LedgerReference_closed_shape_check/);
  });

  it('rejects a flow that is its own parent', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LedgerReference" ("id", "kind", "parentId", "openedAt")
        VALUES ('OR-0000000004', 'ORDER', 'OR-0000000004', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/LedgerReference_parent_not_self_check/);
  });

  it('rejects a wallet holder anchored to a flow instead of a person', async () => {
    const referenceId = await makeReference('OR-0000000005');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerHolder" ("key", "kind", "referenceId", "createdAt")
          VALUES ('USER:1', 'USER', '${referenceId}', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerHolder_anchor_check/);
  });

  it('rejects an escrow holder anchored to a person instead of a flow', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerHolder" ("key", "kind", "userId", "createdAt")
          VALUES ('ESCROW:OR-0000000006', 'ESCROW', ${userId}, CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerHolder_anchor_check/);
  });

  it('rejects a lot of a scalar currency (in sync with LOTTED_CURRENCIES)', async () => {
    const userId = await makeUser();
    const referenceId = await makeReference('CH-0000000001', 'CHARGE');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerLot"
          ("currency", "ownerUserId", "mintReferenceId", "source", "originalAmount", "mintedAt", "validUntil")
          VALUES ('INCOME', ${userId}, '${referenceId}', 'PG', 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerLot_currency_check/);
  });

  it('rejects a lot still cancellable after it has died', async () => {
    const userId = await makeUser();
    const referenceId = await makeReference('CH-0000000002', 'CHARGE');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerLot"
          ("currency", "ownerUserId", "mintReferenceId", "source", "originalAmount", "mintedAt", "validUntil", "cancellableUntil")
          VALUES ('PAID_POINT', ${userId}, '${referenceId}', 'PG', 100,
                  CURRENT_TIMESTAMP, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      ),
    ).rejects.toThrow(/LedgerLot_window_order_check/);
  });

  it('rejects a MINT that names a source, because value entering has none', async () => {
    const referenceId = await makeReference('CH-0000000003', 'CHARGE');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerEvent"
          ("referenceId", "idempotencyKey", "ordinal", "op", "currency", "amount",
           "fromHolderKey", "toHolderKey", "reason", "actorKind", "createdAt")
          VALUES ('${referenceId}', 'k1', 0, 'MINT', 'INCOME', 100,
                  'USER:1', 'USER:2', 'PAYOUT_SETTLE', 'SYSTEM', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerEvent_op_shape_check/);
  });

  it('rejects a swap half with no swap header to belong to', async () => {
    const referenceId = await makeReference('OR-0000000007');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerEvent"
          ("referenceId", "idempotencyKey", "ordinal", "op", "currency", "amount",
           "toHolderKey", "reason", "actorKind", "createdAt")
          VALUES ('${referenceId}', 'k2', 0, 'SWAP_MINT', 'INCOME', 100,
                  'USER:2', 'SETTLE', 'SYSTEM', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerEvent_op_shape_check/);
  });

  it('rejects a lotted movement with no lot, and a scalar one with a lot', async () => {
    const referenceId = await makeReference('OR-0000000008');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerEvent"
          ("referenceId", "idempotencyKey", "ordinal", "op", "currency", "amount",
           "fromHolderKey", "toHolderKey", "reason", "actorKind", "createdAt")
          VALUES ('${referenceId}', 'k3', 0, 'MOVE', 'PAID_POINT', 100,
                  'USER:1', 'ESCROW:OR-0000000008', 'ORDER_STAKE', 'SYSTEM', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerEvent_lot_shape_check/);
  });

  it('rejects a negative amount, because direction is the op and never the sign', async () => {
    const referenceId = await makeReference('OR-0000000009');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerEvent"
          ("referenceId", "idempotencyKey", "ordinal", "op", "currency", "amount",
           "fromHolderKey", "reason", "actorKind", "createdAt")
          VALUES ('${referenceId}', 'k4', 0, 'BURN', 'INCOME', -100,
                  'USER:1', 'EXPIRED', 'SYSTEM', CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerEvent_amount_check/);
  });

  it('rejects the same posting written twice (idempotency is an index)', async () => {
    const referenceId = await makeReference('OR-0000000010');
    const row = (ordinal: number) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerEvent"
          ("referenceId", "idempotencyKey", "ordinal", "op", "currency", "amount",
           "fromHolderKey", "reason", "actorKind", "createdAt")
          VALUES ('${referenceId}', 'once', ${ordinal}, 'BURN', 'INCOME', 100,
                  'USER:1', 'EXPIRED', 'SYSTEM', CURRENT_TIMESTAMP)`,
      );
    await expect(row(0)).resolves.toBe(1);
    await expect(row(1)).resolves.toBe(1); // a posting may write several events
    await expect(row(0)).rejects.toThrow(/LedgerEvent_idempotencyKey_ordinal_key/);
  });

  it('rejects an overdrawn holder (law L6 at the database)', async () => {
    const userId = await makeUser();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LedgerHolder" ("key", "kind", "userId", "createdAt")
        VALUES ('USER:${userId}', 'USER', ${userId}, CURRENT_TIMESTAMP)`,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerBalance" ("holderKey", "currency", "amount", "updatedAt")
          VALUES ('USER:${userId}', 'PAID_POINT', -1, CURRENT_TIMESTAMP)`,
      ),
    ).rejects.toThrow(/LedgerBalance_amount_check/);
  });

  it('accepts a same-currency swap, which a gift of free value really is', async () => {
    const referenceId = await makeReference('GF-0000000001', 'GIFT');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerSwap"
          ("referenceId", "rateKind", "burnCurrency", "mintCurrency", "feePermille", "feeKrw")
          VALUES ('${referenceId}', 'GIFT_CARD_REDEEM', 'FREE_POINT', 'FREE_POINT', 0, 0)`,
      ),
    ).resolves.toBe(1);
  });

  it('rejects an exchange rate the currency graph does not have an edge for', async () => {
    const referenceId = await makeReference('OR-0000000011');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "LedgerSwap"
          ("referenceId", "rateKind", "burnCurrency", "mintCurrency", "feePermille", "feeKrw")
          VALUES ('${referenceId}', 'MILEAGE_CASHOUT', 'MILEAGE', 'INCOME', 0, 0)`,
      ),
    ).rejects.toThrow(/LedgerSwap_rateKind_check/);
  });
});
