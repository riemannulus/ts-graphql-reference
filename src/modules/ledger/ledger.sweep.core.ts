import {
  type CloseReason,
  type Currency,
  type Holder,
  type LottedCurrency,
  parseHolderKey,
  type ReferenceState,
} from './ledger.value.js';
import type { LedgerWorld } from './ledger.plan.core.js';

/**
 * The scheduled sweeps' decisions — small, and deliberately not in the planner.
 *
 * A sweep does not move value by itself: it decides WHAT to move (the due lots,
 * which then become an ordinary posting), or it decides a lifecycle transition
 * that moves nothing at all (voiding an untouched flow), or it decides nothing
 * and only checks (the trial balance). Only the first reaches `planPosting`, so
 * grouping the three by their caller — the three jobs in `jobs/ledger.job.ts` —
 * says more than grouping them by the machinery they happen to share.
 *
 * All three are pure, which is what lets the jobs stay as thin as routes.
 */

/** One lot remainder a sweep has decided to burn. */
export interface DueLot {
  readonly holder: Holder;
  readonly currency: LottedCurrency;
  readonly lotId: number;
  readonly amount: number;
}

/**
 * The lot remainders in this world that have passed their deadline, decided
 * from the SNAPSHOT the posting is checked against rather than from an earlier
 * read — so the amount the plan burns is the amount that is actually there.
 *
 * Only value in a person's wallet is due. What sits in an escrow belongs to a
 * flow that has not finished, and expiring it would delete money out from under
 * a refund; that is a rule about the holder, not about the parcel, which is why
 * it lives here and not in the query.
 */
export function selectDueLots(world: LedgerWorld, now: Date): DueLot[] {
  const byId = new Map(world.lots.map((lot) => [lot.id, lot]));
  const due: DueLot[] = [];
  for (const holding of world.lotBalances) {
    if (holding.amount <= 0) continue;
    const lot = byId.get(holding.lotId);
    if (!lot || now.getTime() <= lot.validUntil.getTime()) continue;
    const holder = parseHolderKey(holding.holderKey);
    if (holder.kind !== 'USER') continue;
    due.push({ holder, currency: lot.currency, lotId: lot.id, amount: holding.amount });
  }
  // Deterministic, so a plan is reproducible from the same world.
  return due.toSorted((a, b) => a.lotId - b.lotId);
}

/** What closing an untouched flow means, as data the repo applies mechanically. */
export interface StaleVoidPlan {
  /** Only a flow in this state may be voided — the guard IS the safety check. */
  readonly assumedState: ReferenceState;
  readonly nextState: ReferenceState;
  readonly closeReason: CloseReason;
  readonly closedAt: Date;
  /** Flows whose window closed at or before this instant. */
  readonly expiredBefore: Date;
}

/**
 * How a flow that was opened and never used ends.
 *
 * A decision, so it lives in the core beside the other transition rule rather
 * than inside a repo's `updateMany` — two encodings of "how a flow ends" is
 * exactly the drift the kernel exists to prevent. `OPEN` already means, by
 * `planReferenceTransition`'s own rule, that nothing has ever moved under the
 * flow, so guarding on it is the whole proof that nothing is being discarded.
 */
export function planStaleVoid(now: Date): StaleVoidPlan {
  return {
    assumedState: 'OPEN',
    nextState: 'CLOSED',
    closeReason: 'VOID',
    closedAt: now,
    expiredBefore: now,
  };
}

// ---------------------------------------------------------------------------
// The trial balance — the sweep's decision
// ---------------------------------------------------------------------------

/** One currency's books: what the event log says, and what the balances say. */
export interface TrialBalanceRow {
  readonly currency: Currency;
  readonly minted: number;
  readonly burned: number;
  readonly held: number;
}

/**
 * The books do not balance: the event log and the balance table disagree about
 * how much of a currency exists. Masked corruption — the sweep throws it so an
 * operator sees it, rather than "correcting" the symptom of a bug.
 */
export class LedgerTrialBalanceError extends Error {
  constructor(readonly rows: readonly TrialBalanceRow[]) {
    super(
      `Ledger trial balance failed: ${rows
        .map((row) => `${row.currency} minted ${row.minted} burned ${row.burned} held ${row.held}`)
        .join('; ')}`,
    );
    this.name = 'LedgerTrialBalanceError';
  }
}

/** Total predicate: does one currency's supply equal what its holders hold? */
export function trialBalanceHolds(row: TrialBalanceRow): boolean {
  return row.minted - row.burned === row.held;
}

/**
 * Asserts law L1 across the whole ledger — the `assertBalanceConsistent` shape:
 * `trialBalanceHolds` names the rule, this adds the throw, so the sweep service
 * stays a plain read → decide with no business `if` in the shell.
 */
export function assertTrialBalance(rows: readonly TrialBalanceRow[]): void {
  const broken = rows.filter((row) => !trialBalanceHolds(row));
  if (broken.length > 0) throw new LedgerTrialBalanceError(broken);
}
