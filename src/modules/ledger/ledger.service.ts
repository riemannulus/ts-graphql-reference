import type { LedgerEvent, LedgerReference } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { isUniqueViolation } from '../../db/prisma-errors.js';
import { uow } from '../../db/uow.js';
import type { Clock } from '../../foundation/clock.js';
import { addDays } from '../../foundation/time.js';
import type { Random } from '../../foundation/random.js';
import { ConcurrentUpdateError } from '../../foundation/errors.js';
import {
  assertTrialBalance,
  type CurrencyRegistry,
  holdersOf,
  type LedgerWorld,
  type Op,
  planPosting,
  planStaleVoid,
  selectDueLots,
  type TrialBalanceRow,
} from './ledger.core.js';
import * as ledgerRepo from './ledger.write.repo.js';
import {
  type Actor,
  type CloseReason,
  type Holder,
  mintReferenceId,
  REFERENCE_ID_ALPHABET,
  REFERENCE_ID_SUFFIX_LENGTH,
  type ReferenceKind,
} from './ledger.value.js';

/**
 * Ledger use-cases — the ONE write path into the ledger's own money.
 *
 * Everything a domain does with ledger value goes through `post`: a top-up is a
 * MINT, paying for an order is a MOVE into escrow, settling it is a SWAP out of
 * it, a refund is that MOVE backwards. There is no second way into these tables,
 * which is what makes the laws in `ledger.core.ts` hold globally rather than
 * wherever someone remembered to call the right helper. (The `point` module
 * keeps its own, separate rows — `src/modules/README.md` says why both exist.)
 *
 * ## Concurrency
 *
 * `post` uses the LOWEST three rungs that hold the invariant, stacked:
 *
 * - **rung 1** — `idempotencyKey` is a unique index, so a webhook delivered
 *   twice writes the movement once. Replay protection is a constraint, not a
 *   lock and not application logic.
 * - **rung 3** — `uow.snapshot`: the balances, the lot remainders and the flow's
 *   state must describe ONE world, or the decision straddles a concurrent
 *   commit and sees a ledger that never existed.
 * - **rung 2** — every write carries the value it assumed, so a lost race misses
 *   instead of overwriting.
 *
 * There is deliberately NO advisory lock, not even for an escrow two people can
 * pay into at once: the guards already turn that race into a retryable
 * `CONFLICT`, and a lock would only convert a rare retry into a queue on every
 * request. If contention on one flow is ever measured to be a problem, the
 * escape hatch is `uow.serialized` on that reference's key — a change to this
 * file alone, because the failure contract (`ConcurrentUpdateError`) is already
 * the same at both rungs.
 */

/**
 * The random half of a reference id, drawn through the app's randomness seam
 * (`foundation/random.ts`) — an effect the module receives, never one it takes.
 *
 * Pure given its bytes: the alphabet is exactly 32 characters, which divides
 * 256, so masking the low five bits is uniform — no modulo bias, no rejection
 * loop, and a test that supplies fixed bytes gets a fixed id.
 */
export function mintSuffix(random: Random): string {
  return Array.from(random.bytes(REFERENCE_ID_SUFFIX_LENGTH), (byte) =>
    REFERENCE_ID_ALPHABET.charAt(byte & 31),
  ).join('');
}

export interface LedgerServiceDeps {
  db: Db;
  /** The seam every use-case reads "now" through (foundation/clock.ts). */
  clock: Clock;
  /** The seam a reference id's random half comes from (foundation/random.ts). */
  random: Random;
  /**
   * The currency policies, bound in the composition root. Required rather than
   * defaulted: "which currencies exist" is a wiring decision, and a default
   * here would quietly put it back inside the module.
   */
  policies: CurrencyRegistry;
}

/** What opening a flow needs. Everything but the kind is optional. */
export interface OpenReferenceInput {
  readonly kind: ReferenceKind;
  /** Nests this flow under another — an order's extra charge, its refund. */
  readonly parentId?: string | null;
  readonly initiatorUserId?: number | null;
  /**
   * When an untouched flow goes stale. The `ledger:reference:void-stale` job
   * closes it VOID; a flow with no window stays OPEN until something moves.
   */
  readonly expiresAt?: Date | null;
  /**
   * The instant this flow opens at. A sweep or a backfill passes the one instant
   * it read, so every row it writes agrees on when "now" was; ordinary callers
   * leave it off and get the clock.
   */
  readonly now?: Date;
}

interface PostRequestBase {
  readonly referenceId: string;
  /** Identifies the POSTING. The same key writes the same movement once. */
  readonly idempotencyKey: string;
  readonly actor: Actor;
  /** Declares that this posting finishes the flow, and why (law L3). */
  readonly closeAs?: CloseReason;
  /**
   * The instant the kernel judges this posting at — which lots have passed their
   * deadline, which are still cancellable. A sweep or a backfill passes the one
   * instant it selected its work with, so the query and the decision cannot
   * disagree about whether a lot is due; ordinary callers leave it off and get
   * the clock.
   */
  readonly now?: Date;
}

/**
 * A posting whose operations are known before the world is read — a top-up, a
 * settlement of a known amount, an operator adjustment.
 */
export interface StaticPostRequest extends PostRequestBase {
  readonly ops: readonly Op[];
}

/**
 * A posting whose operations depend on what the ledger currently holds — "spend
 * 3,000 points", which must pick the lots to drain.
 *
 * `decide` runs INSIDE the transaction, on the same snapshot the plan is
 * checked against, so lot selection and the write it justifies cannot straddle a
 * concurrent spend. It must be pure: it is the decision half of read → decide →
 * execute, and `holders` tells the shell what to read for it.
 */
export interface DerivedPostRequest extends PostRequestBase {
  readonly holders: readonly Holder[];
  readonly decide: (world: LedgerWorld) => readonly Op[];
}

export type PostRequest = StaticPostRequest | DerivedPostRequest;

/** What a posting wrote, and the lots it brought into being. */
export interface PostingResult {
  readonly events: readonly LedgerEvent[];
  readonly mintedLotIds: readonly number[];
  /** True when this call found the movement already applied under its key. */
  readonly replayed: boolean;
}

export interface SweepOptions {
  /** An explicit instant for a backfill or re-run; otherwise the clock. */
  readonly now?: Date;
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 200;

/**
 * How long a sweep's own flow stays reclaimable-but-alive, measured from the
 * wall clock. It must outlive the gap between opening the flow and posting to
 * it, or the void sweep closes the run that is still using it.
 */
const SWEEP_FLOW_LIFETIME_DAYS = 1;

/** What one expiry run did, and whether it ran out of room to do more. */
export interface ExpiryResult {
  /**
   * Wallets swept. This is what `batchSize` caps, so `walletCount === batchSize`
   * is what "there is more waiting" looks like — `expiredCount` cannot say it,
   * because one wallet may hold several lots that all fell due.
   */
  readonly walletCount: number;
  readonly batchSize: number;
  readonly expiredCount: number;
  readonly burnedAmount: number;
  readonly referenceId: string | null;
}

/** The lots a set of events minted — read back off the log, so a replay agrees. */
function mintedLotIdsOf(events: readonly LedgerEvent[]): number[] {
  return events
    .filter((event) => (event.op === 'MINT' || event.op === 'SWAP_MINT') && event.lotId !== null)
    .map((event) => event.lotId!);
}

export function createLedgerService(deps: LedgerServiceDeps) {
  const { db, clock, random, policies } = deps;

  /**
   * Opens a flow. Nothing has moved yet — the id exists so it can be handed to a
   * payment gateway, printed on a receipt, and carried by whatever domain row is
   * eventually born out of this, all before the first cent is committed.
   */
  async function openReference(input: OpenReferenceInput): Promise<LedgerReference> {
    const now = input.now ?? clock.now();
    const id = mintReferenceId(input.kind, mintSuffix(random));
    return uow.run(db, (tx) =>
      ledgerRepo.createReference(tx, {
        id,
        kind: input.kind,
        parentId: input.parentId ?? null,
        initiatorUserId: input.initiatorUserId ?? null,
        expiresAt: input.expiresAt ?? null,
        openedAt: now,
      }),
    );
  }

  /**
   * Applies one atomic movement of value: read the world, decide the plan,
   * execute it.
   *
   * A duplicate delivery returns the FIRST application's events rather than
   * writing a second movement — checked inside the snapshot for the common case,
   * and caught from the unique index for the case where the duplicate is
   * concurrent (where the balance guards may fail first, since the winner's
   * write is invisible to our snapshot until we look for it again).
   */
  async function post(request: PostRequest): Promise<PostingResult> {
    const now = request.now ?? clock.now();
    try {
      const applied = await uow.snapshot(db, async (tx) => {
        const replay = await ledgerRepo.findPostingEvents(tx, request.idempotencyKey);
        if (replay.length > 0) return { events: replay, replayed: true };

        const holders = 'decide' in request ? request.holders : holdersOf(request.ops);
        const world = await ledgerRepo.loadLedgerWorld(tx, request.referenceId, holders); // read
        const ops = 'decide' in request ? request.decide(world) : request.ops;
        const plan = planPosting(
          world,
          {
            referenceId: request.referenceId,
            idempotencyKey: request.idempotencyKey,
            actor: request.actor,
            ops,
            closeAs: request.closeAs,
          },
          policies,
          now,
        ); // decide
        return { events: await ledgerRepo.applyPostingPlan(tx, plan), replayed: false }; // execute
      });
      return {
        events: applied.events,
        mintedLotIds: mintedLotIdsOf(applied.events),
        replayed: applied.replayed,
      };
    } catch (error) {
      // A concurrent delivery of the SAME posting won the race. Distinguish it
      // from a genuine conflict by looking for its events: if they are there, the
      // movement happened exactly once and this caller gets that result.
      if (isUniqueViolation(error) || error instanceof ConcurrentUpdateError) {
        const events = await ledgerRepo.findPostingEvents(db.rw, request.idempotencyKey);
        if (events.length > 0) {
          return { events, mintedLotIds: mintedLotIdsOf(events), replayed: true };
        }
      }
      throw error;
    }
  }

  /**
   * Burns the lot remainders that have passed their deadline in a person's
   * wallet — the `ledger:lot:expire` job.
   *
   * The whole sweep runs as ONE flow (`ADJUST`) and one posting, so the burns and
   * the flow that explains them commit together and the log answers "why did this
   * value disappear on the 30th" with a single id. Value staked in an escrow is
   * skipped by the QUERY, not by a branch here: it belongs to an order that has
   * not finished, and expiring it would delete money out from under a refund.
   *
   * `now` is read ONCE — from `opts.now` (a backfill passing an explicit instant)
   * or the injected clock — and handed to the kernel as data.
   *
   * The first read only finds WHICH WALLETS have work; `selectDueLots` then
   * decides what to burn from the posting's own snapshot. Deciding from the
   * first read instead would price the burn against a world the plan is never
   * checked against, and one concurrent spend would fail the whole batch.
   */
  async function expireDueLots(opts: SweepOptions = {}): Promise<ExpiryResult> {
    const now = opts.now ?? clock.now();
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const wallets = await ledgerRepo.findWalletsWithDueLots(db.rw, now, batchSize);
    if (wallets.length === 0) {
      return { walletCount: 0, batchSize, expiredCount: 0, burnedAmount: 0, referenceId: null };
    }

    // The flow carries its own window, so a sweep that dies before its posting
    // lands leaves a reference `voidStaleReferences` can still reclaim rather
    // than an OPEN row nothing will ever close.
    //
    // The window is a DAY, and it is measured from the WALL CLOCK rather than
    // from `now`. Opening the flow and posting to it are two transactions, and
    // the void sweep runs every ten minutes: a window already in the past would
    // let that sweep close this flow in the gap between them, killing the run
    // that created it. A backfill decides on a historical instant, so measuring
    // the window from it would reopen exactly that race — `expiresAt` is an
    // operational lifetime for a row, not a fact about the instant being swept.
    // Everything else here stays on `now`, which is what makes the backfill a
    // backfill.
    const reference = await openReference({
      kind: 'ADJUST',
      now,
      expiresAt: addDays(clock.now(), SWEEP_FLOW_LIFETIME_DAYS),
    });

    const { events } = await post({
      referenceId: reference.id,
      idempotencyKey: `${reference.id}:expire`,
      actor: { kind: 'SYSTEM', id: null },
      holders: wallets,
      decide: (world) =>
        selectDueLots(world, now).map(
          (lot): Op => ({
            op: 'BURN',
            from: lot.holder,
            tokens: [{ currency: lot.currency, amount: lot.amount, lotId: lot.lotId }],
            reason: 'EXPIRED',
          }),
        ),
      closeAs: 'EXPIRED',
      now,
    });

    // Counted off the EVENTS the posting wrote, not off what `decide` decided:
    // the log is what happened, and `decide` does not run at all on a replay.
    return {
      walletCount: wallets.length,
      batchSize,
      expiredCount: events.length,
      burnedAmount: events.reduce((sum, event) => sum + event.amount, 0),
      referenceId: reference.id,
    };
  }

  /**
   * Closes flows that were opened and never used — the
   * `ledger:reference:void-stale` job.
   *
   * read → decide → execute like every other use-case, even though the decision
   * is small: `planStaleVoid` names the transition in the core, and the repo
   * applies it as ONE guarded statement (rung 0). Encoding the transition in the
   * `updateMany` instead would put "how a flow ends" in two places.
   */
  async function voidStaleReferences(opts: SweepOptions = {}): Promise<{ voidedCount: number }> {
    const now = opts.now ?? clock.now();
    const plan = planStaleVoid(now); // decide (core)
    return uow.run(db, (tx) => ledgerRepo.applyStaleVoid(tx, plan)); // execute
  }

  /**
   * Recomputes each currency's supply from the event log and compares it with
   * what the balance rows say is held — the `ledger:balance:trial` job, and the
   * standing proof that the derived tables still describe the append-only truth.
   *
   * Read-only, so it takes no lock and never blocks a movement. On drift it
   * throws `LedgerTrialBalanceError` (masked corruption, surfaced to operators
   * through agenda's `fail` event) rather than "correcting" the symptom of a bug
   * that would then keep happening.
   */
  async function verifyTrialBalance(): Promise<{ rows: readonly TrialBalanceRow[] }> {
    // On the primary: a correctness decision is not made on replica-lagged state.
    const rows = await ledgerRepo.loadTrialBalance(db.rw); // read
    assertTrialBalance(rows); // decide (core)
    return { rows };
  }

  return { openReference, post, expireDueLots, voidStaleReferences, verifyTrialBalance };
}

export type LedgerService = ReturnType<typeof createLedgerService>;
