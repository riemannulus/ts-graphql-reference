import type { PointCharge, PointSpend } from '@prisma/client';
import type { Db } from '../../db.js';
import { planCharge, planSpend } from './point.core.js';
import * as pointRepo from './point.repo.js';

export interface ChargePointInput {
  paidAmount: number;
  freeAmount: number;
}

export interface SpendPointInput {
  amount: number;
  reason: string;
}

/**
 * Point use-cases. Each method is the read → decide → execute assembly:
 * the repo reads the world, the core decides (returns a plan), the repo
 * executes the plan — all inside one transaction on the PRIMARY (`db.rw`).
 *
 * `db.ro` is never touched here: a use-case must decide on the state it will
 * write against, and a replica may lag. If a method body grows a business
 * `if`, it belongs in point.core.ts; if it grows query-building, it belongs in
 * point.repo.ts.
 */
export function createPointService(db: Db) {
  return {
    /** Tops up a user's points with a new USABLE charge. */
    // `async` so a synchronous core rejection surfaces as a rejected promise,
    // like every other failure of this method.
    async charge(userId: number, input: ChargePointInput): Promise<PointCharge> {
      const plan = planCharge(input); // decide
      return db.rw.$transaction((tx) => pointRepo.applyChargePlan(tx, userId, plan)); // execute
    },

    /**
     * Spends `amount` points (paid-first, FIFO across charges). The plan's
     * optimistic guards make a lost race roll back the whole transaction with
     * a retryable CONFLICT error instead of double-spending.
     */
    spend(userId: number, input: SpendPointInput): Promise<PointSpend> {
      return db.rw.$transaction(async (tx) => {
        const world = await pointRepo.loadSpendWorld(tx, userId); // read
        const plan = planSpend(world.snapshot, world.charges, input.amount); // decide
        return pointRepo.applySpendPlan(tx, userId, input.reason, plan); // execute
      });
    },
  };
}

export type PointService = ReturnType<typeof createPointService>;
