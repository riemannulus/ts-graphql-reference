import {
  type Actor,
  type CloseReason,
  type Currency,
  type EventOp,
  type Holder,
  holderKey,
  type HolderKind,
  type LotSource,
  type LottedCurrency,
  type ReferenceState,
  type ScalarCurrency,
} from './ledger.value.js';
import {
  LedgerAmountNotPositiveError,
  LedgerInsufficientBalanceError,
} from './ledger.errors.core.js';
import type {
  BurnReason,
  MintReason,
  MoveReason,
  SwapRateKind,
} from './ledger.policy.core.js';

/**
 * The three vocabularies a decision is spoken in: what a caller ASKS for
 * (`Op`, `Posting`), what the kernel READS to answer (`LedgerWorld`), and what
 * it RETURNS (`PostingPlan`).
 *
 * This is the contract between the pure core and the shell — the types a repo
 * and a service pass around all day — which is exactly why it is not buried
 * inside the planner. Reading them tells you what a posting can be without
 * reading how one is decided.
 *
 * The three helpers here sit with the types for the same reason: they are how a
 * CALLER prepares a posting, not steps the planner runs. `selectLotsFifo`
 * chooses the lots an op will name, `holdingsOf` reads a wallet out of a world
 * to choose from, and `holdersOf` tells the shell which accounts to load.
 * `planPosting` calls none of them.
 */

// ---------------------------------------------------------------------------
// Tokens and operations
// ---------------------------------------------------------------------------

/**
 * A quantity of one currency. The union enforces the lot rule at the type
 * level: a lotted currency ALWAYS names its lot, a scalar one never does, so
 * "which lot is this?" cannot be forgotten and cannot be asked pointlessly.
 */
export type Token =
  | { readonly currency: LottedCurrency; readonly amount: number; readonly lotId: number }
  | { readonly currency: ScalarCurrency; readonly amount: number; readonly lotId: null };

/** Names one lot's contribution to a movement. `selectLotsFifo` is what mints these. */
const lotToken = (currency: LottedCurrency, lotId: number, amount: number): Token => ({
  currency,
  amount,
  lotId,
});

/**
 * What a mint creates. For a lotted currency the caller supplies only the
 * SOURCE — the deadlines come from the policy, so two mints of the same source
 * can never disagree about how long the value lives.
 */
export type MintTarget =
  | { readonly currency: LottedCurrency; readonly amount: number; readonly source: LotSource }
  | { readonly currency: ScalarCurrency; readonly amount: number; readonly source: null };

/** The four primitives, as data. */
export type Op =
  | {
      readonly op: 'MINT';
      readonly to: Holder;
      readonly target: MintTarget;
      readonly reason: MintReason;
      readonly externalRef?: string;
    }
  | {
      readonly op: 'BURN';
      readonly from: Holder;
      readonly tokens: readonly Token[];
      readonly reason: BurnReason;
      /** Cash that left with this burn. Allowed only where `BURN_SHAPES` says. */
      readonly feeKrw?: number;
      readonly externalRef?: string;
    }
  | {
      readonly op: 'MOVE';
      readonly from: Holder;
      readonly to: Holder;
      readonly tokens: readonly Token[];
      readonly reason: MoveReason;
    }
  | {
      /**
       * Burn `tokens` from `from` and mint the exchanged value to `to`. The
       * amounts on the mint side are DERIVED from the rate, so a caller cannot
       * quietly mint more than it burned; the rebate (when the rate has one)
       * goes to `rebateTo`, defaulting to `to`.
       */
      readonly op: 'SWAP';
      readonly from: Holder;
      readonly to: Holder;
      readonly tokens: readonly Token[];
      readonly rate: SwapRateKind;
      readonly rebateTo?: Holder;
      readonly externalRef?: string;
    };

/**
 * One atomic call into the ledger. `idempotencyKey` makes replay a database
 * constraint rather than application logic (concurrency ladder rung 1): the
 * same key writes the same movement once, however many times a webhook is
 * delivered.
 */
export interface Posting {
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  readonly ops: readonly Op[];
  /**
   * Declares that this posting finishes the flow, and why. Required when the
   * posting empties the reference's holders — a flow does not get to end
   * without saying how it ended.
   */
  readonly closeAs?: CloseReason;
}

// ---------------------------------------------------------------------------
// The world the decision reads
// ---------------------------------------------------------------------------

export interface BalanceRow {
  readonly holderKey: string;
  readonly currency: Currency;
  readonly amount: number;
}

export interface LotRow {
  readonly id: number;
  readonly currency: LottedCurrency;
  readonly ownerUserId: number;
  readonly source: LotSource;
  readonly originalAmount: number;
  readonly validUntil: Date;
  readonly cancellableUntil: Date | null;
}

export interface LotBalanceRow {
  readonly lotId: number;
  readonly holderKey: string;
  readonly amount: number;
}

/**
 * Everything `planPosting` decides against, read in ONE snapshot (the service
 * runs it at REPEATABLE READ): the reference's lifecycle state, the balances
 * and lot balances of every holder the posting touches PLUS every holder of the
 * reference itself (so "is this flow finished?" is answerable), and the lots
 * those balances belong to.
 */
export interface LedgerWorld {
  readonly reference: { readonly id: string; readonly state: ReferenceState };
  readonly balances: readonly BalanceRow[];
  readonly lots: readonly LotRow[];
  readonly lotBalances: readonly LotBalanceRow[];
  /** Holder keys that already have a row; the plan creates the others. */
  readonly knownHolderKeys: readonly string[];
  /** Holder keys belonging to this reference (its escrow / payable accounts). */
  readonly referenceHolderKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** A lot the plan points at: an existing row, or one this plan creates. */
export type LotPointer =
  | { readonly kind: 'EXISTING'; readonly lotId: number }
  | { readonly kind: 'PLANNED'; readonly ref: number };

export interface PlannedLot {
  readonly ref: number;
  readonly currency: LottedCurrency;
  readonly ownerUserId: number;
  readonly source: LotSource;
  readonly originalAmount: number;
  readonly mintedAt: Date;
  readonly validUntil: Date;
  readonly cancellableUntil: Date | null;
}

export interface PlannedHolder {
  readonly key: string;
  readonly kind: HolderKind;
  readonly userId: number | null;
  readonly referenceId: string | null;
}

export interface PlannedSwap {
  readonly ref: number;
  readonly rateKind: SwapRateKind;
  readonly burnCurrency: Currency;
  readonly mintCurrency: Currency;
  readonly feePermille: number;
  readonly feeKrw: number;
}

export interface PlannedEvent {
  readonly ordinal: number;
  readonly op: EventOp;
  readonly currency: Currency;
  readonly amount: number;
  readonly lot: LotPointer | null;
  readonly fromHolderKey: string | null;
  readonly toHolderKey: string | null;
  readonly reason: string;
  readonly swapRef: number | null;
  readonly feeKrw: number;
  readonly externalRef: string | null;
}

/**
 * One balance row to write. `assumed` is what the decision SAW — `null` when
 * there was no row — and the repo turns it into the guard on the update, so a
 * concurrent movement makes this write miss instead of overwriting it.
 */
export interface BalanceWrite {
  readonly holderKey: string;
  readonly currency: Currency;
  readonly assumed: number | null;
  readonly after: number;
}

export interface LotBalanceWrite {
  readonly lot: LotPointer;
  readonly holderKey: string;
  readonly assumed: number | null;
  readonly after: number;
}

export interface ReferenceWrite {
  readonly assumedState: ReferenceState;
  readonly nextState: ReferenceState;
  readonly closeReason: CloseReason | null;
  readonly closedAt: Date | null;
}

/**
 * The complete, not-yet-executed description of one posting. Pure data: when a
 * value of this type exists, nothing has happened to the database yet.
 */
export interface PostingPlan {
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  readonly now: Date;
  readonly holdersToCreate: readonly PlannedHolder[];
  readonly lotsToCreate: readonly PlannedLot[];
  readonly swapsToCreate: readonly PlannedSwap[];
  readonly events: readonly PlannedEvent[];
  readonly balanceWrites: readonly BalanceWrite[];
  readonly lotBalanceWrites: readonly LotBalanceWrite[];
  readonly reference: ReferenceWrite;
}

// ---------------------------------------------------------------------------
// FIFO lot selection — the mechanism a lotted currency "inherits"
// ---------------------------------------------------------------------------

/** A lot with its remainder at one holder, as the selector sees it. */
export interface LotHolding {
  readonly lot: LotRow;
  readonly amount: number;
}

/**
 * Picks the lots that pay for `amount`, oldest first.
 *
 * FIFO because a lot expires: draining the oldest first is what keeps value
 * from dying in a wallet that had enough to spend. `excludeSources` is how a
 * payout skips value it may not cash out (store-bought points) — those lots stay
 * spendable, they simply cannot leave through the bank.
 *
 * Total: returns the tokens or throws `LedgerInsufficientBalanceError`; never
 * returns a partial selection.
 */
export function selectLotsFifo(
  holdings: readonly LotHolding[],
  currency: LottedCurrency,
  amount: number,
  opts: { readonly excludeSources?: readonly LotSource[] } = {},
): Token[] {
  if (!Number.isInteger(amount) || amount <= 0) throw new LedgerAmountNotPositiveError(amount);
  const excluded = opts.excludeSources ?? [];
  const eligible = holdings
    .filter(
      (holding) =>
        holding.lot.currency === currency &&
        holding.amount > 0 &&
        !excluded.includes(holding.lot.source),
    )
    // Oldest lot first; `id` breaks ties for lots minted in the same millisecond
    // so the order is deterministic and a replay picks the same lots.
    .toSorted(
      (a, b) =>
        a.lot.validUntil.getTime() - b.lot.validUntil.getTime() || a.lot.id - b.lot.id,
    );

  const tokens: Token[] = [];
  let left = amount;
  for (const holding of eligible) {
    if (left === 0) break;
    const take = Math.min(left, holding.amount);
    left -= take;
    tokens.push(lotToken(currency, holding.lot.id, take));
  }
  if (left > 0) {
    const available = eligible.reduce((sum, holding) => sum + holding.amount, 0);
    throw new LedgerInsufficientBalanceError('the selection', currency, available, amount);
  }
  return tokens;
}

/**
 * Every holder a set of operations touches — what the shell must load before
 * the decision can be made. Pure, so the service never has to guess (and a
 * holder it failed to load would surface as a conflict, not a wrong number).
 */
export function holdersOf(ops: readonly Op[]): Holder[] {
  const seen = new Map<string, Holder>();
  const add = (holder: Holder) => seen.set(holderKey(holder), holder);
  for (const op of ops) {
    switch (op.op) {
      case 'MINT':
        add(op.to);
        break;
      case 'BURN':
        add(op.from);
        break;
      case 'MOVE':
        add(op.from);
        add(op.to);
        break;
      default:
        add(op.from);
        add(op.to);
        if (op.rebateTo) add(op.rebateTo);
    }
  }
  return [...seen.values()];
}

/** The holdings of one holder, assembled from a world snapshot. */
export function holdingsOf(world: LedgerWorld, holder: Holder): LotHolding[] {
  const key = holderKey(holder);
  const lots = new Map(world.lots.map((lot) => [lot.id, lot]));
  const holdings: LotHolding[] = [];
  for (const row of world.lotBalances) {
    if (row.holderKey !== key || row.amount <= 0) continue;
    const lot = lots.get(row.lotId);
    if (lot) holdings.push({ lot, amount: row.amount });
  }
  return holdings;
}
