import type { PointCharge, PointSpend } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import type { AppEventPublisher } from '../../events/event-registry.js';
import type { Outbox } from '../../events/outbox.js';
import type { Clock } from '../../foundation/clock.js';
import type { FlagReader } from '../../flags/flag-registry.js';
import {
  assertBalanceConsistent,
  planCharge,
  planExpiry,
  planSpend,
  planTransfer,
} from './point.core.js';
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

/** Options for `expire`: an explicit `now` for a backfill / re-run; omitted on
 * the scheduled path so the injected clock supplies it. */
export interface ExpirePointsOptions {
  now?: Date;
}

/**
 * The event seams. Both halves of the delivery ladder are injected because the
 * module uses BOTH — see the `pointBalanceChanged` notes on each use-case below.
 * A service only ever holds the WRITE half of the bus (lint-enforced): it
 * publishes, it never subscribes.
 */
export interface PointServiceDeps {
  events: AppEventPublisher;
  outbox: Outbox;
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
 *
 * `clock` is the injected `now` seam. Time-sensitive use-cases (`expire`) read it
 * ONCE, at the top of the read phase, and pass the instant to the core as data —
 * the service never reads a clock deeper in, and the core never reads one at all.
 * Production binds `systemClock` in the composition root; tests inject a fixed
 * clock so behavior is deterministic (CONVENTIONS §10 "Time").
 */
export function createPointService(db: Db, clock: Clock, deps: PointServiceDeps) {
  return {
    /**
     * Tops up a user's points with a new USABLE charge.
     *
     * The module's ONE rung-1 (outbox) path, and the reason is the money: a
     * top-up is where value enters, so a client that never learns its balance
     * moved reads as "I paid and got nothing" — a support ticket, not a stale
     * pixel. The event is written INSIDE the transaction, so it commits with the
     * charge or vanishes with it, and `notify()` afterwards is a latency
     * optimization the scheduled drain does not depend on.
     */
    // `async` so a synchronous core rejection surfaces as a rejected promise.
    async charge(userId: number, input: ChargePointInput): Promise<PointCharge> {
      const plan = planCharge(input, clock.now()); // decide (chargedAt stamped from the clock)
      const charge = await uow.run(db, async (tx) => {
        const created = await pointRepo.applyChargePlan(tx, userId, plan); // execute
        await deps.outbox.enqueue(tx, 'pointBalanceChanged', userId, { userId });
        return created;
      });
      deps.outbox.notify(); // after commit — a wake-up, never the delivery guarantee
      return charge;
    },

    /**
     * Spends `amount` points (paid-first, FIFO across charges).
     *
     * Rung 0: the spender is already looking at the result of their own action,
     * so a lost event costs a redundant refetch, not correctness. Published
     * strictly AFTER the awaited transaction — inside it, a rollback would hand
     * subscribers an event for a write that never landed and their re-fetch
     * would kill the subscription.
     */
    async spend(userId: number, input: SpendPointInput): Promise<PointSpend> {
      const spend = await uow.snapshot(db, async (tx) => {
        const world = await pointRepo.loadPointWorld(tx, userId); // read
        const plan = planSpend(world.snapshot, world.charges, input.amount); // decide
        return pointRepo.applySpendPlan(tx, userId, input.reason, plan); // execute
      });
      deps.events.publish('pointBalanceChanged', userId, { userId }); // after commit
      return spend;
    },

    /**
     * Expires a user's USABLE charges past their deadline, removing each
     * remainder from the balance in one snapshot-isolated transaction.
     *
     * `now` is read ONCE here — from `opts.now` (a backfill / re-run passing an
     * explicit instant) or the injected clock (the scheduled path) — and handed to
     * the pure core as data; nothing deeper reads a clock. This is the codebase's
     * two sanctioned "now" shapes side by side: a request/job reads the clock, a
     * replay passes the instant in.
     *
     * `uow.snapshot` for the SAME reason as `spend`: the balance and the charges
     * must describe one world, and the plan's optimistic guards turn a lost race
     * (a concurrent spend on the same ledger) into a retryable `CONFLICT`. A
     * scheduled job would call this per user id returned by an index scan for
     * due charges; the reference exposes the per-user unit and leaves the sweep
     * driver (a cron/route) to a future delivery, as `feature-flag` does.
     */
    async expire(userId: number, opts: ExpirePointsOptions = {}): Promise<{ expiredCount: number }> {
      const now = opts.now ?? clock.now();
      const result = await uow.snapshot(db, async (tx) => {
        const world = await pointRepo.loadExpiryWorld(tx, userId); // read
        const plan = planExpiry(world, now); // decide
        return pointRepo.applyExpiryPlan(tx, userId, plan); // execute
      });
      // Rung 0, and GATED: `applyExpiryPlan` commits a transaction that wrote
      // nothing when there is nothing due, which is the common case for a sweep
      // over every user. Publishing unconditionally would wake every subscriber
      // on every pass to re-read an unchanged balance — the filtering that
      // belongs at the publish site, not in a downstream operator.
      if (result.expiredCount > 0) {
        deps.events.publish('pointBalanceChanged', userId, { userId });
      }
      return result;
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
     *
     * Two feature-flag modes, side by side (both read BEFORE the transaction, as
     * data, from the per-request `ctx.flags` — the singleton service never stores
     * request state, exactly as `ctx.db` reaches a repo):
     *
     * - `pointTransfer` (mode 2, kill/rollout gate) — `assert` throws
     *   `FeatureDisabledError` (→ client code `UNAVAILABLE`) before any lock or
     *   read. Checked in the use-case, not the resolver, so a future non-GraphQL
     *   caller (a job, a route) is gated too — the service is the one choke point.
     * - `pointTransferPreferFree` (mode 1, rule change) — its boolean flows into
     *   the pure core (`planTransfer` → `planSpend`) as DATA; the ordering branch
     *   lives there, not here, so there is no business `if` in the shell.
     */
    async transfer(
      fromUserId: number,
      toUserId: number,
      input: TransferPointInput,
      flags: FlagReader,
    ): Promise<PointSpend> {
      await flags.assert.pointTransfer();
      const preferFree = await flags.pointTransferPreferFree();
      const now = clock.now(); // the receiver charge's chargedAt (stamped, not @default)
      const { spend } = await uow.serialized(
        db,
        [lockKey.pointBalance(fromUserId), lockKey.pointBalance(toUserId)],
        async (tx) => {
          const world = await pointRepo.loadPointWorld(tx, fromUserId); // read
          const plan = planTransfer(fromUserId, toUserId, world, input.amount, now, { preferFree }); // decide
          return pointRepo.applyTransferPlan(tx, fromUserId, toUserId, plan); // execute
        },
        { snapshot: true },
      );
      // Rung 0, TWICE: a transfer moves value between two ledgers, so BOTH
      // balances changed and both users may be watching. Keying is per-user, so
      // one event cannot serve both — the receiver would never be told. Missing
      // this is the easy bug, because the transaction returns only the sender's
      // spend record.
      deps.events.publish('pointBalanceChanged', fromUserId, { userId: fromUserId });
      deps.events.publish('pointBalanceChanged', toUserId, { userId: toUserId });
      return spend;
    },

    /**
     * Verifies that every user's denormalized `PointBalance` still equals the
     * sum of their USABLE charges — the work behind the `point:balance:verify`
     * job, the reference's read-only, defense-in-depth sweep (crepe's
     * clairvoyance balance-check analogue). Each user is checked in its OWN
     * `uow.snapshot`: the balance and the charges must describe ONE consistent
     * world, so a concurrent spend landing between the two reads cannot make a
     * healthy ledger look drifted — the very reason `spend` reads under snapshot.
     * It is READ-ONLY, so it takes no lock and never blocks a spend; overlapping
     * runs are harmless. On drift it throws `PointBalanceDriftError` (masked
     * corruption, not silently corrected). Returns how many users were checked.
     */
    async verifyBalances(): Promise<{ usersChecked: number }> {
      // The population to check, read on the primary (a correctness decision is
      // made on primary state) and outside any per-user transaction.
      const userIds = await pointRepo.findUserIdsWithBalanceOrUsableCharges(db.rw);
      for (const userId of userIds) {
        // eslint-disable-next-line no-await-in-loop -- bounded per-user snapshot, sequential by design
        await uow.snapshot(db, async (tx) => {
          const world = await pointRepo.loadPointWorld(tx, userId); // read
          assertBalanceConsistent(userId, world.snapshot, world.charges); // decide (core)
        });
      }
      return { usersChecked: userIds.length };
    },
  };
}

export type PointService = ReturnType<typeof createPointService>;
