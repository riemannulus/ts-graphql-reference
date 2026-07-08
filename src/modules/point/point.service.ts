import { Prisma, type PointCharge, type PointSpend } from '@prisma/client';
import { isSerializationConflict, type Db } from '../../db.js';
import { ConcurrentUpdateError } from '../../errors.js';
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
     * Spends `amount` points (paid-first, FIFO across charges).
     *
     * REPEATABLE READ gives the decision ONE snapshot: the balance and the
     * charges are guaranteed to describe the same world (under the default
     * READ COMMITTED, each read gets its own snapshot and a concurrent charge
     * or spend committing between them would masquerade as ledger corruption).
     * A lost race then surfaces one of two ways, both mapped to a retryable
     * CONFLICT: the plan's optimistic guards miss (the rival committed before
     * our snapshot was taken), or Postgres reports a serialization failure
     * (the rival committed after). Either way the transaction rolls back —
     * never a double-spend.
     */
    async spend(userId: number, input: SpendPointInput): Promise<PointSpend> {
      try {
        return await db.rw.$transaction(
          async (tx) => {
            const world = await pointRepo.loadSpendWorld(tx, userId); // read
            const plan = planSpend(world.snapshot, world.charges, input.amount); // decide
            return pointRepo.applySpendPlan(tx, userId, input.reason, plan); // execute
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      } catch (error) {
        if (isSerializationConflict(error)) {
          throw new ConcurrentUpdateError(`points of user ${userId}`);
        }
        throw error;
      }
    },
  };
}

export type PointService = ReturnType<typeof createPointService>;
