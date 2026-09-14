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

async function makeFinancialWorld() {
  const holder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: 'ledger-owner' },
  });
  const otherHolder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: 'other-owner' },
  });
  const available = await prisma.financialAccount.create({
    data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  const otherAvailable = await prisma.financialAccount.create({
    data: { holderId: otherHolder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  const reservation = await prisma.financialReservation.create({
    data: {
      referenceId: 'payment:ledger',
      bindingNamespace: 'order-payment',
      bindingKey: 'ledger',
      holderId: holder.id,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      targetAmount: 100,
    },
  });
  const escrow = await prisma.financialAccount.create({
    data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
  });
  const lot = await prisma.pointLot.create({
    data: {
      accountId: available.id,
      sourceKind: 'PAID',
      originalAmount: 100,
      remainingAmount: 100,
    },
  });
  const otherLot = await prisma.pointLot.create({
    data: {
      accountId: otherAvailable.id,
      sourceKind: 'PAID',
      originalAmount: 100,
      remainingAmount: 100,
    },
  });
  return { holder, available, otherAvailable, reservation, escrow, lot, otherLot };
}

async function makeCommittedTransfer() {
  const world = await makeFinancialWorld();
  await prisma.$transaction(async (tx) => {
    await tx.pointLot.update({ where: { id: world.lot.id }, data: { remainingAmount: 0 } });
    const transfer = await tx.financialTransfer.create({
      data: {
        reservationId: world.reservation.id,
        fromAccountId: world.available.id,
        toAccountId: world.escrow.id,
        amount: 100,
      },
    });
    await tx.financialTransferAllocation.create({
      data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
    });
  });
  return world;
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

  it('rejects reusing one financial reservation binding', async () => {
    const holderId = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialHolder" ("bindingNamespace", "bindingKey")
      VALUES ('user', '1') RETURNING "id"
    `;
    await prisma.$executeRaw`
      INSERT INTO "FinancialReservation"
        ("referenceId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
      VALUES ('payment:1', 'order-payment', '1', ${holderId[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "FinancialReservation"
          ("referenceId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
        VALUES ('payment:2', 'order-payment', '1', ${holderId[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
      `,
    ).rejects.toThrow(/FinancialReservation_bindingNamespace_bindingKey_key/);
  });

  it('rejects forming two contracts from one order', async () => {
    const buyerId = await makeUser();
    const worker = await prisma.user.create({ data: { email: 'worker-checks@example.com' } });
    const commissionType = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "CommissionType" ("workerId", "title", "price")
      VALUES (${worker.id}, 'portrait', 100) RETURNING "id"
    `;
    const slot = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "CommissionSlot" ("workerId") VALUES (${worker.id}) RETURNING "id"
    `;
    const order = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "Order" ("buyerId", "commissionTypeId", "slotId", "titleSnapshot", "amount")
      VALUES (${buyerId}, ${commissionType[0]!.id}, ${slot[0]!.id}, 'portrait', 100) RETURNING "id"
    `;
    await prisma.$executeRaw`
      INSERT INTO "Contract" ("orderId", "buyerId", "workerId")
      VALUES (${order[0]!.id}, ${buyerId}, ${worker.id})
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "Contract" ("orderId", "buyerId", "workerId")
        VALUES (${order[0]!.id}, ${buyerId}, ${worker.id})
      `,
    ).rejects.toThrow(/Contract_orderId_key/);
  });

  it('rejects a financial account with both holder and reservation ownership', async () => {
    const holder = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialHolder" ("bindingNamespace", "bindingKey")
      VALUES ('user', 'account-owner') RETURNING "id"
    `;
    const reservation = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialReservation"
        ("referenceId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
      VALUES ('payment:account', 'order-payment', 'account', ${holder[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
      RETURNING "id"
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "FinancialAccount" ("currency", "purpose", "holderId", "reservationId")
        VALUES ('POINT', 'AVAILABLE', ${holder[0]!.id}, ${reservation[0]!.id})
      `,
    ).rejects.toThrow(/FinancialAccount_owner_check/);
  });

  it('rejects a transfer whose amount differs from its reservation target', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 99,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 99 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects a transfer sourced from another holder', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.otherAvailable.id,
            toAccountId: world.escrow.id,
            amount: 100,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.otherLot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects a transfer sent to another reservation escrow account', async () => {
    const world = await makeFinancialWorld();
    const otherReservation = await prisma.financialReservation.create({
      data: {
        referenceId: 'payment:other-escrow',
        bindingNamespace: 'order-payment',
        bindingKey: 'other-escrow',
        holderId: world.holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });
    const otherEscrow = await prisma.financialAccount.create({
      data: {
        reservationId: otherReservation.id,
        currency: 'POINT',
        purpose: 'ESCROW',
      },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: otherEscrow.id,
            amount: 100,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects transfer allocations whose sum differs from the transfer amount', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 99 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects an allocation from a lot outside the transfer source account', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.otherLot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects an allocation that leaves the same value spendable in its source lot', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/PointLot_conservation_check/);
  });

  it('rejects allocating more than the source lot originally contained', async () => {
    const world = await makeFinancialWorld();
    await prisma.financialReservation.update({
      where: { id: world.reservation.id },
      data: { targetAmount: 101 },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 101,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 101 },
        });
      }),
    ).rejects.toThrow(/PointLot_conservation_check/);
  });

  it('rejects changing a reservation amount after its transfer is committed', async () => {
    const world = await makeCommittedTransfer();
    await expect(
      prisma.financialReservation.update({
        where: { id: world.reservation.id },
        data: { targetAmount: 99 },
      }),
    ).rejects.toThrow(/FinancialReservation_transfer_basis_immutable/);
  });

  it('rejects moving an allocated lot to a different account', async () => {
    const world = await makeCommittedTransfer();
    await expect(
      prisma.pointLot.update({
        where: { id: world.lot.id },
        data: { accountId: world.otherAvailable.id },
      }),
    ).rejects.toThrow(/PointLot_allocation_basis_immutable/);
  });

  it('rejects changing ownership of an account used by a committed transfer', async () => {
    const world = await makeCommittedTransfer();
    const replacementHolder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: 'replacement-owner' },
    });
    await expect(
      prisma.financialAccount.update({
        where: { id: world.available.id },
        data: { holderId: replacementHolder.id },
      }),
    ).rejects.toThrow(/FinancialAccount_transfer_basis_immutable/);
  });
});
