import type { PointCharge, PointSpend } from '@prisma/client';
import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError } from '../../foundation/errors.js';
import type {
  ChargeBalance,
  ChargePlan,
  ExpiryPlan,
  ExpiryWorld,
  PointSnapshot,
  SpendPlan,
  TransferPlan,
} from './point.core.js';

/**
 * Point persistence, write path — the use-case executors. Shaped by USE CASE,
 * not by table: `applySpendPlan` deliberately crosses three tables
 * (charge/balance/spend) inside one transaction, because that whole shape IS
 * the unit of work. Splitting it per model would scatter one atomic use-case
 * across files and invite reuse of a half-executor outside its plan.
 *
 * The pattern is the load/apply pair: `loadSpendWorld` reads the world the
 * core decides on, then `apply*Plan` mechanically executes the plan it
 * returned. No business branching on the write side — every `if` that matters
 * happened in point.core.ts. (`loadSpendWorld` is a read, but it belongs here:
 * it feeds a plan inside the spend transaction, it is not a GraphQL
 * projection — those live in point.read.repo.ts.)
 *
 * Which client a function runs on (rw / a transaction) is ALWAYS the caller's
 * choice, passed as the first parameter.
 */

const ZERO_SNAPSHOT: PointSnapshot = { paidAmount: 0, freeAmount: 0, totalAmount: 0 };

/** Everything `planSpend` needs, read in one place (run this inside the spend tx). */
export interface SpendWorld {
  snapshot: PointSnapshot;
  /** USABLE charges in spend (FIFO) order, mapped to the core's contract type. */
  charges: ChargeBalance[];
}

export async function loadSpendWorld(db: ReadDbClient, userId: number): Promise<SpendWorld> {
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

/**
 * Everything `planExpiry` needs, read in one place (run this inside the expiry
 * tx). Like `loadSpendWorld` this reads two rows that must describe ONE world —
 * so the service runs it at REPEATABLE READ (`uow.snapshot`); it lives here, not
 * in the read repo, because it feeds a WRITE decision, not a GraphQL projection.
 */
export async function loadExpiryWorld(db: ReadDbClient, userId: number): Promise<ExpiryWorld> {
  const balance = await db.pointBalance.findUnique({ where: { userId } });
  const charges = await db.pointCharge.findMany({
    where: { userId, state: 'USABLE' },
    orderBy: [{ chargedAt: 'asc' }, { id: 'asc' }],
  });
  return {
    snapshot: balance ?? ZERO_SNAPSHOT,
    charges: charges.map((c) => ({
      id: c.id,
      unspentPaid: c.unspentPaidAmount,
      unspentFree: c.unspentFreeAmount,
      chargedAt: c.chargedAt,
    })),
  };
}

/**
 * Executes an `ExpiryPlan`: marks each due charge EXPIRED (zeroing its remainder
 * and stamping the plan's `expiredAt`), then decrements the balance by the total
 * removed. Purely mechanical — every decision, including which charges and the
 * guard values, already lives in the plan.
 *
 * Same optimistic-concurrency shape as `applySpendPlan`: each write is guarded by
 * the plan's assumptions, so a charge consumed (or a balance moved) by a
 * concurrent spend after the world was read makes the guarded write miss, and the
 * thrown `ConcurrentUpdateError` rolls the transaction back rather than
 * double-counting. An empty plan writes nothing.
 */
export async function applyExpiryPlan(
  db: DbClient,
  userId: number,
  plan: ExpiryPlan,
): Promise<{ expiredCount: number }> {
  if (plan.expirations.length === 0) return { expiredCount: 0 };

  for (const expiration of plan.expirations) {
    // eslint-disable-next-line no-await-in-loop
    const { count } = await db.pointCharge.updateMany({
      where: {
        id: expiration.chargeId,
        state: 'USABLE',
        unspentPaidAmount: expiration.assumed.unspentPaid,
        unspentFreeAmount: expiration.assumed.unspentFree,
      },
      data: {
        state: 'EXPIRED',
        unspentPaidAmount: 0,
        unspentFreeAmount: 0,
        expiredAt: plan.expiredAt,
      },
    });
    if (count !== 1) {
      throw new ConcurrentUpdateError(`point charge ${expiration.chargeId}`);
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

  return { expiredCount: plan.expirations.length };
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
      // Stamped from the plan (app clock), not left to @default(now()) — chargedAt
      // is read back by the expiry decision, so it is single-clocked (§10).
      chargedAt: plan.chargedAt,
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
