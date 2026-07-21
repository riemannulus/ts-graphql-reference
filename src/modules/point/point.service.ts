import type { PointCharge, PointSpend } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import { planCharge, planSpend, planTransfer } from './point.core.js';
import * as pointRepo from './point.write.repo.js';

export interface ChargePointInput {
  paidAmount: number;
  freeAmount: number;
}

export interface SpendPointInput {
  amount: number;
  reason: string;
}

export interface TransferPointInput {
  amount: number;
}

/**
 * Point use-cases. Each method is the read → decide → execute assembly on the
 * PRIMARY (`db.rw`), opened through `uow` — the toolkit picks the isolation and
 * (for transfers) the locks, so the body stays pure orchestration. Each method
 * uses the LOWEST rung of the concurrency ladder that preserves its invariant:
 *
 * - `charge` → `uow.run`: one charge + a balance upsert; nothing to decide
 *   against a prior read, so a plain atomic transaction suffices.
 * - `spend` → `uow.snapshot`: the balance and charges must describe one world;
 *   REPEATABLE READ gives the decision a single snapshot and the plan's guards
 *   catch a lost race as a retryable CONFLICT.
 * - `transfer` → `uow.serialized`: touches TWO users' ledgers; see below.
 *
 * `db.ro` is never touched — a use-case decides on the state it will write, and
 * a replica may lag.
 */
export function createPointService(db: Db) {
  return {
    /** Tops up a user's points with a new USABLE charge. */
    // `async` so a synchronous core rejection surfaces as a rejected promise.
    async charge(userId: number, input: ChargePointInput): Promise<PointCharge> {
      const plan = planCharge(input); // decide
      return uow.run(db, (tx) => pointRepo.applyChargePlan(tx, userId, plan)); // execute
    },

    /** Spends `amount` points (paid-first, FIFO across charges). */
    async spend(userId: number, input: SpendPointInput): Promise<PointSpend> {
      return uow.snapshot(db, async (tx) => {
        const world = await pointRepo.loadSpendWorld(tx, userId); // read
        const plan = planSpend(world.snapshot, world.charges, input.amount); // decide
        return pointRepo.applySpendPlan(tx, userId, input.reason, plan); // execute
      });
    },

    /**
     * Moves `amount` points from one user to another, atomically.
     *
     * This is the reference's advisory-lock (Level 5) example. It locks BOTH
     * users' point keys, acquired in the global order so two opposing transfers
     * (A→B and B→A) can never deadlock. The lock's job is to serialize
     * transfer-vs-transfer with a fixed order; correctness against lock-free
     * `spend`/`charge` still comes from the reused optimistic guards, and the
     * `snapshot` flag keeps the sender's world read consistent against them.
     * Returns the sender's spend record (the movement's authoritative entry).
     */
    async transfer(
      fromUserId: number,
      toUserId: number,
      input: TransferPointInput,
    ): Promise<PointSpend> {
      const { spend } = await uow.serialized(
        db,
        [lockKey.pointBalance(fromUserId), lockKey.pointBalance(toUserId)],
        async (tx) => {
          const world = await pointRepo.loadSpendWorld(tx, fromUserId); // read
          const plan = planTransfer(fromUserId, toUserId, world, input.amount); // decide
          return pointRepo.applyTransferPlan(tx, fromUserId, toUserId, plan); // execute
        },
        { snapshot: true },
      );
      return spend;
    },
  };
}

export type PointService = ReturnType<typeof createPointService>;
