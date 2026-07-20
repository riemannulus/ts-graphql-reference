import type { PointCharge, PointSpend, Prisma } from '@prisma/client';
import type { DbClient } from '../../db.js';
import { ConcurrentUpdateError } from '../../errors.js';
import type {
  ChargeBalance,
  ChargePlan,
  PointSnapshot,
  SpendPlan,
  TransferPlan,
} from './point.core.js';

/**
 * Point persistence — the only point-module file that talks Prisma.
 *
 * Two kinds of functions live here:
 *
 * - Read projections for the GraphQL query path. They accept the Pothos
 *   `query` object (`select`/`include`) and spread it, so the plugin's
 *   relation-loading optimization survives. The `query` parameter STOPS at
 *   this layer: it is Prisma-shaped (a translation of the GraphQL selection),
 *   so the repo is where it belongs — services never see it.
 *
 * - The use-case pair `loadSpendWorld` / `applySpendPlan`: read the world the
 *   core decides on, then mechanically execute the plan it returned. No
 *   business branching on the write side — every `if` that matters happened in
 *   point.core.ts.
 *
 * Which client a function runs on (rw / ro / a transaction) is ALWAYS the
 * caller's choice, passed as the first parameter.
 */

const ZERO_SNAPSHOT: PointSnapshot = { paidAmount: 0, freeAmount: 0, totalAmount: 0 };

/** Everything `planSpend` needs, read in one place (run this inside the spend tx). */
export interface SpendWorld {
  snapshot: PointSnapshot;
  /** USABLE charges in spend (FIFO) order, mapped to the core's contract type. */
  charges: ChargeBalance[];
}

export async function loadSpendWorld(db: DbClient, userId: number): Promise<SpendWorld> {
  // Sequential, not Promise.all: interactive-transaction handles do not
  // support concurrent operations. The two reads only form ONE world because
  // the spend transaction runs at REPEATABLE READ (point.service.ts) — under
  // READ COMMITTED each statement would get its own snapshot, and a charge
  // committing between them would make a healthy ledger look corrupt.
  const balance = await db.pointBalance.findUnique({ where: { userId } });
  const charges = await db.pointCharge.findMany({
    where: { userId, state: 'USABLE' },
    // `id` breaks ties for charges created in the same millisecond, keeping
    // the FIFO order deterministic.
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
  });
  return {
    snapshot: balance ?? ZERO_SNAPSHOT,
    charges: charges.map((c) => ({
      id: c.id,
      unspentPaid: c.unspentPaidAmount,
      unspentFree: c.unspentFreeAmount,
    })),
  };
}

/**
 * Executes a `SpendPlan`: consumes each allocated charge, decrements the
 * balance, and records the spend. Purely mechanical — the plan already carries
 * every decision, including the values each UPDATE must match on.
 *
 * Every UPDATE is guarded by the plan's assumptions (optimistic concurrency):
 * if a concurrent spend consumed a charge or moved the balance after the world
 * was read, the guarded write misses, and the thrown `ConcurrentUpdateError`
 * rolls back the surrounding transaction instead of double-spending.
 */
export async function applySpendPlan(
  db: DbClient,
  userId: number,
  reason: string,
  plan: SpendPlan,
): Promise<PointSpend> {
  for (const allocation of plan.allocations) {
    // Sequential on purpose: these run inside one interactive transaction
    // (Prisma does not support concurrent operations on a tx handle), and the
    // guards must be evaluated in plan order.
    // eslint-disable-next-line no-await-in-loop
    const { count } = await db.pointCharge.updateMany({
      where: {
        id: allocation.chargeId,
        state: 'USABLE',
        unspentPaidAmount: allocation.assumed.unspentPaid,
        unspentFreeAmount: allocation.assumed.unspentFree,
      },
      data: {
        state: allocation.depleted ? 'CONSUMED' : undefined,
        unspentPaidAmount: { decrement: allocation.paid },
        unspentFreeAmount: { decrement: allocation.free },
      },
    });
    if (count !== 1) {
      throw new ConcurrentUpdateError(`point charge ${allocation.chargeId}`);
    }
  }

  const { count } = await db.pointBalance.updateMany({
    where: {
      userId,
      paidAmount: plan.assumedBalance.paidAmount,
      freeAmount: plan.assumedBalance.freeAmount,
      totalAmount: plan.assumedBalance.totalAmount,
    },
    data: {
      paidAmount: plan.balanceAfter.paidAmount,
      freeAmount: plan.balanceAfter.freeAmount,
      totalAmount: plan.balanceAfter.totalAmount,
    },
  });
  if (count !== 1) {
    throw new ConcurrentUpdateError(`point balance of user ${userId}`);
  }

  return db.pointSpend.create({
    data: {
      userId,
      paidAmount: plan.paidUsage,
      freeAmount: plan.freeUsage,
      totalAmount: plan.paidUsage + plan.freeUsage,
      reason,
    },
  });
}

/**
 * Executes a `TransferPlan`: consumes the sender's charges + records the spend,
 * then credits the receiver with a new charge. It reuses the SAME guarded
 * executors as standalone spend/charge, so the transfer stays correct even
 * against a lock-free single-user spend or charge running concurrently (the
 * advisory lock the service holds serializes transfer-vs-transfer; the guards
 * cover the rest). Returns both ledger records.
 */
export async function applyTransferPlan(
  db: DbClient,
  fromUserId: number,
  toUserId: number,
  plan: TransferPlan,
): Promise<{ spend: PointSpend; charge: PointCharge }> {
  const spend = await applySpendPlan(db, fromUserId, `transfer to user ${toUserId}`, plan.spend);
  const charge = await applyChargePlan(db, toUserId, plan.charge);
  return { spend, charge };
}

/** Executes a `ChargePlan`: creates the charge and upserts the balance increments. */
export async function applyChargePlan(
  db: DbClient,
  userId: number,
  plan: ChargePlan,
): Promise<PointCharge> {
  const charge = await db.pointCharge.create({
    data: {
      userId,
      paidAmount: plan.paidAmount,
      freeAmount: plan.freeAmount,
      unspentPaidAmount: plan.paidAmount,
      unspentFreeAmount: plan.freeAmount,
    },
  });
  await db.pointBalance.upsert({
    where: { userId },
    create: {
      userId,
      paidAmount: plan.paidAmount,
      freeAmount: plan.freeAmount,
      totalAmount: plan.totalAmount,
    },
    update: {
      paidAmount: { increment: plan.paidAmount },
      freeAmount: { increment: plan.freeAmount },
      totalAmount: { increment: plan.totalAmount },
    },
  });
  return charge;
}

// --- Read projections (GraphQL query path) ---------------------------------

export function findBalance(
  db: DbClient,
  userId: number,
  query: Prisma.PointBalanceDefaultArgs = {},
) {
  return db.pointBalance.findUnique({ ...query, where: { userId } });
}

export function findCharges(
  db: DbClient,
  userId: number,
  query: Prisma.PointChargeFindManyArgs = {},
) {
  return db.pointCharge.findMany({
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
    ...query,
    where: { userId },
  });
}

export function findSpends(db: DbClient, userId: number, query: Prisma.PointSpendFindManyArgs = {}) {
  return db.pointSpend.findMany({
    orderBy: { createdAt: 'desc' },
    ...query,
    where: { userId },
  });
}

export function getChargeById(db: DbClient, id: number, query: Prisma.PointChargeDefaultArgs = {}) {
  return db.pointCharge.findUniqueOrThrow({ ...query, where: { id } });
}

export function getSpendById(db: DbClient, id: number, query: Prisma.PointSpendDefaultArgs = {}) {
  return db.pointSpend.findUniqueOrThrow({ ...query, where: { id } });
}
