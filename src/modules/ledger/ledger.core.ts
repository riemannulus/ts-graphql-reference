import { DomainError } from '../../foundation/errors.js';
import { addDays } from '../../foundation/time.js';
import {
  type Actor,
  type CloseReason,
  type Currency,
  type EventOp,
  type Holder,
  holderKey,
  type HolderKind,
  isLottedCurrency,
  isPersonalHolder,
  type LotSource,
  parseHolderKey,
  type LottedCurrency,
  parseMember,
  type ReferenceState,
  type ScalarCurrency,
} from './ledger.value.js';

/**
 * The ledger kernel — the pure core where every movement of value is decided.
 *
 * ## The shape of the thing
 *
 * Money does not get deleted when it is spent; it goes somewhere. So there are
 * only four primitives, and three of them conserve value:
 *
 * - `MINT` / `BURN` — the supply boundary. Value enters or leaves the ledger.
 * - `MOVE` — value changes holder, keeping its currency AND its lot identity.
 *   Paying for an order is a MOVE into escrow, not a deletion; a refund is the
 *   same MOVE backwards, which is why the refunded lots come back with their
 *   original expiry instead of being reconstructed from a stored split.
 * - `SWAP` — the only way to cross a currency boundary, and it is a BURN plus a
 *   MINT, never a transfer: settling an order destroys the buyer's points and
 *   creates the seller's income. The difference between the two is the fee, so
 *   an exchange can never inflate a currency's supply.
 *
 * Where that fee GOES is the rate's business, not the kernel's, and it differs
 * per edge. On `SETTLE` it is handed straight back to the seller as loyalty
 * value (`rebate`), so the platform's cut is recorded in `feeKrw` for the cash
 * books while remaining, economically, a liability owed back — not net revenue.
 * An edge with `rebate: null` keeps it. Both are one number either way, which
 * is the point of computing the fee and the grant in one place (law L2).
 *
 * "Stake", "unstake" and "settle" are not primitives — they are a MOVE into
 * escrow, a MOVE out of it, and a SWAP out of it. That collapse is the point:
 * eight refund flavours in the system this replaces (full, partial, mutual,
 * half-complete, admin split, payment-method, clawback, reversal) are all the
 * same question — how do the escrow's tokens divide between MOVE-back and
 * SWAP-forward — so they share one implementation and one set of laws.
 *
 * ## Currency-agnostic by construction
 *
 * This file names no currency. Policies (`CurrencyPolicy`) arrive as DATA — the
 * weakest rung of the coupling ladder — so adding a currency is a new file under
 * `currencies/`, never an edit here, and WHICH currencies exist is decided in
 * the composition root. The two policy SHAPES (lotted / scalar) are a
 * discriminated union rather than a class hierarchy: the mechanism a lotted
 * currency "inherits" (FIFO selection, expiry, the cancellation window) lives
 * once in this kernel, keyed off `policy.kind`.
 *
 * ## The laws
 *
 * Everything below serves these. They are numbered because the rest of the
 * module cites them — the shape tables, the CHECK constraints in the migration,
 * the property tests — and a citation needs somewhere to point.
 *
 * - **L1 conservation** — across a posting, the change in all balances equals
 *   what was minted minus what was burned, per currency. A `MOVE` therefore
 *   changes no total, and `ledger:balance:trial` re-proves this hourly against
 *   the whole event log.
 * - **L2 swap balance** — an exchange mints exactly what it burned less the
 *   fee, and where the rate names a rebate, the rebate IS that fee. Both are
 *   computed here and never supplied, so a caller cannot mint more than it
 *   destroyed.
 * - **L3 escrow closure** — a flow closes only when its own accounts hold
 *   nothing, and it must say why it closed. No money is left stranded in a
 *   finished order.
 * - **L4 lot identity** — a move carries the SAME lot to the other side, so a
 *   refund returns the deadlines and the funding source the payment created,
 *   rather than a reconstruction of them.
 * - **L5 movement shape** — `MINT` has only a destination, `BURN` only a
 *   source, `MOVE` both; which holder kinds each may run between is a table
 *   (`MOVE_SHAPES` / `MINT_SHAPES` / `BURN_SHAPES` / `SWAP_RATES`), never a
 *   pile of conditionals.
 * - **L6 non-negativity** — no account is ever left owing. What a clawback
 *   cannot recover is minted onto a RECEIVABLE account as a recognized loss: a
 *   positive number in a named place, never an overdrawn wallet.
 * - **L7 open flow** — a closed reference takes no further postings, and no
 *   posting may put value into another flow's accounts.
 * - **L8 idempotency** — one idempotency key writes one movement, enforced by
 *   a unique index rather than by application logic.
 *
 * ## Decide here, execute in the shell
 *
 * `planPosting` reads a world snapshot and returns a `PostingPlan`: pure data
 * describing every row to write, each carrying the value it ASSUMED
 * (`assumed`), which the repo turns into an optimistic-concurrency guard. No
 * database, no clock — `now` is a parameter. Every business branch is here,
 * where a property test can run thousands of ledgers per second.
 */

// ---------------------------------------------------------------------------
// Reasons — why a movement happened, as closed sets
// ---------------------------------------------------------------------------

/** Why value entered the ledger. */
export const MINT_REASONS = [
  'PG_CHARGE',
  'IAP_CHARGE',
  'PG_BONUS',
  'EVENT',
  'ADMIN_GRANT',
  /** What a clawback could not recover, recognized as a loss on RECEIVABLE. */
  'LOSS_RECOGNITION',
  /** The migration entry that seeds a balance carried over from a prior system. */
  'OPENING',
] as const;
export type MintReason = (typeof MINT_REASONS)[number];

/** Why value left the ledger. */
export const BURN_REASONS = [
  /** Statutory cooling-off: an untouched lot goes back to what funded it. */
  'PG_REFUND',
  'BANK_WITHDRAWAL',
  'EXPIRED',
  'IAP_REVOKE',
  'ADMIN_REVOKE',
  /** Bonus value granted alongside a refunded charge dies with it. */
  'FORFEIT_ON_REFUND',
  'STORE_PURCHASE',
] as const;
export type BurnReason = (typeof BURN_REASONS)[number];

/** Why value changed hands without changing currency. */
export const MOVE_REASONS = [
  'ORDER_STAKE',
  'ORDER_UNSTAKE',
  'GIFT_STAKE',
  'GIFT_UNSTAKE',
  'PAYOUT_STAKE',
  'PAYOUT_UNSTAKE',
  'CLAWBACK',
  'CLAWBACK_RELEASE',
] as const;
export type MoveReason = (typeof MOVE_REASONS)[number];

/**
 * Law L5, as a table rather than a pile of conditionals: which holder kinds a
 * movement may run between. Escrow and payable are transit accounts, so nothing
 * mints into them and nothing moves between two of them; there is no
 * `USER → USER` shape at all, because a person-to-person movement must hang off
 * a reference (stake, then redeem) or the funding audit and the ability to
 * reverse it are both lost.
 */
const MOVE_SHAPES = {
  ORDER_STAKE: { from: ['USER'], to: ['ESCROW'] },
  ORDER_UNSTAKE: { from: ['ESCROW'], to: ['USER'] },
  GIFT_STAKE: { from: ['USER'], to: ['ESCROW'] },
  GIFT_UNSTAKE: { from: ['ESCROW'], to: ['USER'] },
  /** Only a redeemable currency may reach a payable — see `CurrencyPolicy.redeem`. */
  PAYOUT_STAKE: { from: ['USER'], to: ['PAYABLE'], redeemable: true },
  PAYOUT_UNSTAKE: { from: ['PAYABLE'], to: ['USER'] },
  CLAWBACK: { from: ['USER', 'ESCROW'], to: ['RECEIVABLE'] },
  CLAWBACK_RELEASE: { from: ['RECEIVABLE'], to: ['USER'] },
} as const satisfies Record<
  MoveReason,
  { from: readonly HolderKind[]; to: readonly HolderKind[]; redeemable?: true }
>;

/**
 * Where a mint may land. Value enters at a person — never straight into an
 * escrow, which would let an order fund itself out of nothing.
 */
const MINT_SHAPES = {
  PG_CHARGE: { to: ['USER'] },
  IAP_CHARGE: { to: ['USER'] },
  PG_BONUS: { to: ['USER'] },
  EVENT: { to: ['USER'] },
  ADMIN_GRANT: { to: ['USER'] },
  LOSS_RECOGNITION: { to: ['RECEIVABLE'] },
  OPENING: { to: ['USER'] },
} as const satisfies Record<MintReason, { to: readonly HolderKind[] }>;

/**
 * Where a burn may draw from, whether it may carry cash out (`cash`), and what
 * it demands of the lot it burns.
 *
 * `lot: 'INTACT'` is the cooling-off rule made structural: a lot may go back to
 * its funding source only while nothing has been spent from it and the window is
 * open. Nothing needs a boolean column that a cron flips — the state IS the
 * remainder plus the deadline, so a race with a spend cannot open the window
 * back up.
 */
const BURN_SHAPES = {
  PG_REFUND: { from: ['USER'], cash: null, lot: 'INTACT' },
  BANK_WITHDRAWAL: { from: ['PAYABLE'], cash: 'REDEEM_FEE', lot: null },
  EXPIRED: { from: ['USER'], cash: null, lot: 'DUE' },
  IAP_REVOKE: { from: ['USER'], cash: null, lot: null },
  ADMIN_REVOKE: { from: ['USER'], cash: null, lot: null },
  FORFEIT_ON_REFUND: { from: ['USER'], cash: null, lot: null },
  STORE_PURCHASE: { from: ['USER'], cash: 'PRICE', lot: null },
} as const satisfies Record<
  BurnReason,
  {
    from: readonly HolderKind[];
    /**
     * What `feeKrw` means on this burn, and who decides it.
     *
     * - `REDEEM_FEE` — the kernel COMPUTES it from the currency's redeem policy
     *   (`redeemFee`) and refuses a caller-supplied number. A withdrawal fee is
     *   a rule, so letting the caller name it would make the policy decorative.
     * - `PRICE` — the caller supplies what the goods cost, because only it
     *   knows; the kernel only requires it to be positive.
     * - `null` — no cash leaves, so any fee at all is a mistake.
     */
    cash: 'REDEEM_FEE' | 'PRICE' | null;
    lot: 'INTACT' | 'DUE' | null;
  }
>;

// ---------------------------------------------------------------------------
// The currency graph — which exchanges exist at all
// ---------------------------------------------------------------------------

/**
 * The closed set of currency edges. An exchange that is not in this table
 * cannot be expressed: `SwapRateFor<'MILEAGE', 'INCOME'>` is `never`, so "cash
 * out the loyalty currency" fails to compile rather than failing a review.
 *
 * `feePermille` is the platform's cut, taken at the moment of exchange and
 * handed back as `rebate` in the loyalty currency — which is why the fee and
 * the loyalty grant can never disagree (law L2), instead of being two writes in
 * two modules that must be kept in step.
 */
export const SWAP_RATES = {
  /** An order settles: the buyer's points become the seller's income. */
  SETTLE: {
    from: ['PAID_POINT', 'FREE_POINT'],
    to: 'INCOME',
    fromKinds: ['ESCROW'],
    toKinds: ['USER'],
    rebate: 'MILEAGE',
    mintLotSource: null,
    feePermille: 100,
  },
  /** A gift is redeemed: the giver's points become the receiver's free points. */
  GIFT_CARD_REDEEM: {
    from: ['PAID_POINT', 'FREE_POINT'],
    to: 'FREE_POINT',
    fromKinds: ['ESCROW'],
    toKinds: ['USER'],
    rebate: null,
    mintLotSource: 'GIFT_CARD',
    feePermille: 0,
  },
  /** Income becomes spendable points, one for one. */
  POINT_CONVERSION: {
    from: ['INCOME'],
    to: 'PAID_POINT',
    fromKinds: ['USER'],
    toKinds: ['USER'],
    rebate: null,
    mintLotSource: 'INCOME_SWAP',
    feePermille: 0,
  },
} as const satisfies Record<
  string,
  {
    from: readonly Currency[];
    to: Currency;
    /** Which accounts an exchange may run between — law L5, as for the others. */
    fromKinds: readonly HolderKind[];
    toKinds: readonly HolderKind[];
    rebate: Currency | null;
    mintLotSource: LotSource | null;
    feePermille: number;
  }
>;

export type SwapRateKind = keyof typeof SWAP_RATES;
export const SWAP_RATE_KINDS = Object.keys(SWAP_RATES) as readonly SwapRateKind[];
/** Parses `LedgerSwap.rateKind` back off the row (parse, don't validate). */
export const parseSwapRateKind = (value: string): SwapRateKind =>
  parseMember(SWAP_RATE_KINDS, value, 'swap rate kind');

/**
 * The rate that exchanges `From` into `To`, or `never` when the graph has no
 * such edge. Typed op builders take this, so an impossible exchange is a
 * compile error at the call site — the type-level half of the runtime table.
 */
export type SwapRateFor<From extends Currency, To extends Currency> = {
  [K in SwapRateKind]: From extends (typeof SWAP_RATES)[K]['from'][number]
    ? To extends (typeof SWAP_RATES)[K]['to']
      ? K
      : never
    : never;
}[SwapRateKind];

// ---------------------------------------------------------------------------
// Currency policies — the per-currency data the kernel decides against
// ---------------------------------------------------------------------------

/** What it costs and what it takes to turn a currency back into cash. */
export interface RedeemPolicy {
  /** Fee rate in parts per thousand. */
  readonly feePermille: number;
  /** Floor on the fee, for amounts small enough that the rate is not worth it. */
  readonly minimumFee: number;
  /** Smallest amount a payout may request. */
  readonly minimumAmount: number;
  /**
   * Lot sources this currency may NOT be paid out from. Value bought through a
   * store is refunded by that store, so letting it leave through our bank
   * account would make the refund impossible to reconcile.
   */
  readonly excludeLotSources: readonly LotSource[];
}

interface CurrencyPolicyBase {
  /** How the balance appears in the books, once it leaves this system. */
  readonly accounting: 'DEFERRED_REVENUE' | 'PROVISION' | 'PAYABLE';
  /** The kinds of account allowed to hold it. */
  readonly holderKinds: readonly HolderKind[];
  /**
   * Every reason this currency may be created for — the primitive reasons AND
   * the exchange edges that mint it, because a swap's halves are a mint and a
   * burn like any other and are checked against these same lists. A currency
   * that omits an edge cannot be produced by it, whatever `SWAP_RATES` says.
   */
  readonly mintReasons: readonly (MintReason | SwapRateKind)[];
  readonly burnReasons: readonly (BurnReason | SwapRateKind)[];
  readonly moveReasons: readonly MoveReason[];
  /** `null` means the currency cannot become cash — a fact, not a convention. */
  readonly redeem: RedeemPolicy | null;
}

/** A currency held as named parcels: it has lots, deadlines, and a FIFO order. */
export interface LottedCurrencyPolicy extends CurrencyPolicyBase {
  readonly kind: 'LOTTED';
  readonly code: LottedCurrency;
  /** Days from mint until a lot's remainder is swept. */
  readonly lifetimeDays: number;
  /** Days a lot may be returned to its funding source; `null` disables it. */
  readonly cancellationDays: number | null;
  /** Sources whose lots the cancellation window applies to at all. */
  readonly cancellableSources: readonly LotSource[];
}

/** A currency held as one running balance. */
export interface ScalarCurrencyPolicy extends CurrencyPolicyBase {
  readonly kind: 'SCALAR';
  readonly code: ScalarCurrency;
}

export type CurrencyPolicy = LottedCurrencyPolicy | ScalarCurrencyPolicy;

/** Every currency's policy, injected into the kernel as data. */
export type CurrencyRegistry = Readonly<Record<Currency, CurrencyPolicy>>;

/**
 * The fee a payout of `amount` costs under this policy — `max(rate, floor)`,
 * rounded up so rounding never favours the payer. Pure; the shell shows it to
 * the user before they commit and charges exactly this at the burn.
 */
export function redeemFee(policy: RedeemPolicy, amount: number): number {
  return Math.max(Math.ceil((amount * policy.feePermille) / 1000), policy.minimumFee);
}

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
// Errors
// ---------------------------------------------------------------------------

/**
 * An operation named an escrow or payable account that belongs to a DIFFERENT
 * money flow. Refused, and not as a matter of taste: an account is owned by the
 * flow that can close it, so funding someone else's escrow would strand value
 * where only that flow can free it — and that flow may already be closed.
 */
export class LedgerForeignHolderError extends DomainError {
  constructor(
    readonly account: string,
    readonly referenceId: string,
  ) {
    super(
      `Holder ${account} belongs to another flow and cannot be used by ${referenceId}`,
      'LEDGER_FOREIGN_HOLDER',
    );
    this.name = 'LedgerForeignHolderError';
  }
}

/** A burn named a cash amount its shape does not allow, or omitted a required one. */
export class LedgerFeeNotAllowedError extends DomainError {
  constructor(
    readonly reason: string,
    readonly why: string,
  ) {
    super(`Burn for ${reason} cannot carry this fee: ${why}`, 'LEDGER_FEE_NOT_ALLOWED');
    this.name = 'LedgerFeeNotAllowedError';
  }
}

/** A payout was asked for less than the currency's policy allows to be sent. */
export class LedgerBelowPayoutMinimumError extends DomainError {
  constructor(
    readonly currency: Currency,
    readonly amount: number,
    readonly minimum: number,
  ) {
    super(
      `A ${currency} payout of ${amount} is below the minimum of ${minimum}`,
      'LEDGER_BELOW_PAYOUT_MINIMUM',
    );
    this.name = 'LedgerBelowPayoutMinimumError';
  }
}

/** An operation named no tokens, or named tokens of more than one currency. */
export class LedgerTokenCurrencyError extends DomainError {
  constructor(
    readonly reason: string,
    readonly why: 'EMPTY' | 'MIXED',
  ) {
    super(
      why === 'EMPTY'
        ? `${reason} names nothing to move`
        : `${reason} must name tokens of a single currency`,
      'LEDGER_TOKEN_CURRENCY',
    );
    this.name = 'LedgerTokenCurrencyError';
  }
}

/** A posting was addressed to a flow that has already finished. */
export class LedgerReferenceClosedError extends DomainError {
  constructor(readonly referenceId: string) {
    super(`Ledger reference ${referenceId} is closed`, 'LEDGER_REFERENCE_CLOSED');
  }
}

/** A posting names a flow that does not exist. */
export class LedgerReferenceNotFoundError extends DomainError {
  constructor(readonly referenceId: string) {
    super(`Ledger reference ${referenceId} does not exist`, 'LEDGER_REFERENCE_NOT_FOUND');
  }
}

export class LedgerAmountNotPositiveError extends DomainError {
  constructor(readonly amount: number) {
    super(`Ledger amounts must be positive integers, got ${amount}`, 'LEDGER_INVALID_AMOUNT');
  }
}

/** A holder cannot cover what the posting takes from it. */
export class LedgerInsufficientBalanceError extends DomainError {
  constructor(
    /** The account's name — `holderKey(holder)`. */
    readonly account: string,
    readonly currency: Currency,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `${account} holds ${available} ${currency}, needs ${requested}`,
      'LEDGER_INSUFFICIENT_BALANCE',
    );
  }
}

/** This kind of account is not allowed to hold this currency at all. */
export class LedgerCurrencyNotHoldableError extends DomainError {
  constructor(
    readonly currency: Currency,
    readonly holderKind: HolderKind,
  ) {
    super(`${currency} cannot be held by a ${holderKind} account`, 'LEDGER_CURRENCY_NOT_HOLDABLE');
  }
}

/** The reason is not one this currency admits for this primitive. */
export class LedgerReasonNotAllowedError extends DomainError {
  constructor(
    readonly currency: Currency,
    readonly op: string,
    readonly reason: string,
  ) {
    super(`${currency} does not allow ${op} for reason ${reason}`, 'LEDGER_REASON_NOT_ALLOWED');
  }
}

/** The movement's endpoints are not a shape law L5 permits. */
export class LedgerMovementNotAllowedError extends DomainError {
  constructor(
    readonly reason: string,
    readonly from: HolderKind | null,
    readonly to: HolderKind | null,
  ) {
    super(
      `${reason} may not move value from ${from ?? '—'} to ${to ?? '—'}`,
      'LEDGER_MOVEMENT_NOT_ALLOWED',
    );
  }
}

/** A cooling-off return was attempted on a lot that is no longer eligible. */
export class LedgerLotNotCancellableError extends DomainError {
  constructor(
    readonly lotId: number,
    readonly why: 'WINDOW_CLOSED' | 'ALREADY_SPENT',
  ) {
    super(
      why === 'WINDOW_CLOSED'
        ? `Lot ${lotId} is past its cancellation window`
        : `Lot ${lotId} has been spent from and can no longer be returned`,
      'LEDGER_LOT_NOT_CANCELLABLE',
    );
  }
}

/** An expiry sweep tried to burn a lot that is still alive. */
export class LedgerLotNotDueError extends DomainError {
  constructor(readonly lotId: number) {
    super(`Lot ${lotId} has not expired yet`, 'LEDGER_LOT_NOT_DUE');
  }
}

/** A payout tried to draw from a lot its currency's redeem policy excludes. */
export class LedgerLotNotRedeemableError extends DomainError {
  constructor(
    readonly lotId: number,
    readonly source: LotSource,
  ) {
    super(
      `Lot ${lotId} came from ${source} and cannot be paid out`,
      'LEDGER_LOT_NOT_REDEEMABLE',
    );
  }
}

/** The exchange is not an edge of the currency graph, or mixes burn currencies. */
export class LedgerSwapNotAllowedError extends DomainError {
  constructor(
    readonly rate: string,
    readonly detail: string,
  ) {
    super(`Swap ${rate} is not allowed: ${detail}`, 'LEDGER_SWAP_NOT_ALLOWED');
  }
}

/** The posting emptied the flow without saying how it ended. */
export class LedgerCloseReasonRequiredError extends DomainError {
  constructor(readonly referenceId: string) {
    super(
      `Posting empties reference ${referenceId}; it must declare closeAs`,
      'LEDGER_CLOSE_REASON_REQUIRED',
    );
  }
}

/** A close was declared while the flow still holds value (law L3). */
export class LedgerCloseNotEmptyError extends DomainError {
  constructor(
    readonly referenceId: string,
    readonly remaining: number,
  ) {
    super(
      `Reference ${referenceId} still holds ${remaining}; it cannot be closed`,
      'LEDGER_CLOSE_NOT_EMPTY',
    );
  }
}

/** VOID means "nothing ever moved", so a posting that moves value cannot claim it. */
export class LedgerVoidNotEmptyError extends DomainError {
  constructor(readonly referenceId: string) {
    super(
      `Reference ${referenceId} cannot be voided: value has moved under it`,
      'LEDGER_VOID_NOT_EMPTY',
    );
  }
}

/**
 * The world handed to the kernel is not the world the posting names. A shell
 * bug, never a caller's: MASKED, because it means the decision was about to be
 * made against the wrong flow's balances.
 */
export class LedgerWorldMismatchError extends Error {
  constructor(
    readonly referenceId: string,
    readonly worldReferenceId: string,
  ) {
    super(`Posting for ${referenceId} was given the world of ${worldReferenceId}`);
    this.name = 'LedgerWorldMismatchError';
  }
}

/**
 * The plan does not conserve value: the change in balances disagrees with what
 * was minted and burned. Unreachable in a correct kernel, so — like
 * `PointLedgerInconsistencyError` — a plain, MASKED Error rather than a
 * client-visible `DomainError`. It is the last line before a wrong number
 * reaches the database.
 */
export class LedgerConservationError extends Error {
  constructor(
    readonly currency: Currency,
    readonly supplyDelta: number,
    readonly balanceDelta: number,
  ) {
    super(
      `Ledger conservation violated for ${currency}: supply moved by ${supplyDelta}, ` +
        `balances by ${balanceDelta}`,
    );
    this.name = 'LedgerConservationError';
  }
}

/**
 * The registry and a caller disagree about a currency's shape — a lotted
 * currency was minted without a lot source, or the reverse. Wiring corruption,
 * not user input, so it is masked.
 */
export class LedgerPolicyMismatchError extends Error {
  constructor(readonly currency: Currency) {
    super(`Currency policy for ${currency} disagrees with the mint target's shape`);
    this.name = 'LedgerPolicyMismatchError';
  }
}

/** A holder's lot balances stopped summing to its balance. Also corruption. */
export class LedgerLotCoherenceError extends Error {
  constructor(
    /** The account's name — `holderKey(holder)`. */
    readonly account: string,
    readonly currency: Currency,
    readonly balanceDelta: number,
    readonly lotDelta: number,
  ) {
    super(
      `Lot balances for ${account}/${currency} moved by ${lotDelta} while the ` +
        `balance moved by ${balanceDelta}`,
    );
    this.name = 'LedgerLotCoherenceError';
  }
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

// ---------------------------------------------------------------------------
// planPosting
// ---------------------------------------------------------------------------

/** Internal: the mutable working state one plan is built up in. */
interface Working {
  readonly balances: Map<string, number>;
  readonly balanceAssumed: Map<string, number | null>;
  readonly lotBalances: Map<string, number>;
  readonly lotBalanceAssumed: Map<string, number | null>;
  readonly holders: Map<string, PlannedHolder>;
  readonly lots: PlannedLot[];
  readonly swaps: PlannedSwap[];
  readonly events: PlannedEvent[];
  /** Per currency: minted minus burned, for the conservation check. */
  readonly supplyDelta: Map<Currency, number>;
}

const balanceCell = (key: string, currency: Currency) => `${key}|${currency}`;
const lotCellKey = (lot: LotPointer) =>
  lot.kind === 'EXISTING' ? `E${lot.lotId}` : `P${lot.ref}`;
const lotCell = (lot: LotPointer, key: string) => `${lotCellKey(lot)}|${key}`;

function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new LedgerAmountNotPositiveError(amount);
}

/**
 * Records a holder the plan touches, creating it if this is its first movement.
 * A holder row is bookkeeping, not a decision — it exists because something is
 * about to be true of it.
 *
 * The ONE rule enforced here, at the single point every operation's holders pass
 * through: a flow-anchored account (ESCROW, PAYABLE) may only be touched by the
 * flow that owns it. Without it, a posting could stake into another order's
 * escrow — value that its own reference's L3 check cannot see, that the owning
 * flow may already have closed over, and that no posting on either flow can
 * then free. Personal accounts (USER, RECEIVABLE) are anchored to a person and
 * are reachable by any flow, which is what makes a payment possible at all.
 */
function touchHolder(work: Working, world: LedgerWorld, holder: Holder): string {
  const key = holderKey(holder);
  if (!isPersonalHolder(holder) && holder.referenceId !== world.reference.id) {
    throw new LedgerForeignHolderError(key, world.reference.id);
  }
  if (world.knownHolderKeys.includes(key) || work.holders.has(key)) return key;
  work.holders.set(key, {
    key,
    kind: holder.kind,
    userId: isPersonalHolder(holder) ? holder.userId : null,
    referenceId: isPersonalHolder(holder) ? null : holder.referenceId,
  });
  return key;
}

/**
 * The ONE currency a set of tokens is in.
 *
 * Demanded wherever a currency's own POLICY decides a number — a withdrawal
 * fee, a payout floor, an exchange rate. Reading the currency off the first
 * token and then summing across all of them would let the array's ORDER pick
 * which policy applies, which is how a mixed withdrawal of income and points
 * gets charged at whichever happened to be listed first. A mixed operation is
 * not forbidden as a matter of taste: it is two operations, and saying so costs
 * a caller one more entry in `ops`.
 */
function soleCurrencyOf(tokens: readonly Token[], reason: string): Currency {
  const first = tokens[0];
  if (first === undefined) throw new LedgerTokenCurrencyError(reason, 'EMPTY');
  if (tokens.some((token) => token.currency !== first.currency)) {
    throw new LedgerTokenCurrencyError(reason, 'MIXED');
  }
  return first.currency;
}

function assertHoldable(policy: CurrencyPolicy, holder: Holder): void {
  if (!policy.holderKinds.includes(holder.kind)) {
    throw new LedgerCurrencyNotHoldableError(policy.code, holder.kind);
  }
}

/** Applies a delta to a holder's balance, remembering what it assumed. */
function shiftBalance(
  work: Working,
  world: LedgerWorld,
  key: string,
  currency: Currency,
  delta: number,
): void {
  const cell = balanceCell(key, currency);
  if (!work.balanceAssumed.has(cell)) {
    const existing = world.balances.find(
      (row) => row.holderKey === key && row.currency === currency,
    );
    work.balanceAssumed.set(cell, existing?.amount ?? null);
    work.balances.set(cell, existing?.amount ?? 0);
  }
  const next = (work.balances.get(cell) ?? 0) + delta;
  if (next < 0) {
    throw new LedgerInsufficientBalanceError(key, currency, next - delta, -delta);
  }
  work.balances.set(cell, next);
}

/** Applies a delta to a lot's remainder at one holder. */
function shiftLotBalance(
  work: Working,
  world: LedgerWorld,
  lot: LotPointer,
  key: string,
  currency: LottedCurrency,
  delta: number,
): void {
  const cell = lotCell(lot, key);
  if (!work.lotBalanceAssumed.has(cell)) {
    const existing =
      lot.kind === 'EXISTING'
        ? world.lotBalances.find((row) => row.lotId === lot.lotId && row.holderKey === key)
        : undefined;
    work.lotBalanceAssumed.set(cell, existing?.amount ?? null);
    work.lotBalances.set(cell, existing?.amount ?? 0);
  }
  const next = (work.lotBalances.get(cell) ?? 0) + delta;
  if (next < 0) {
    throw new LedgerInsufficientBalanceError(key, currency, next - delta, -delta);
  }
  work.lotBalances.set(cell, next);
}

function shiftSupply(work: Working, currency: Currency, delta: number): void {
  work.supplyDelta.set(currency, (work.supplyDelta.get(currency) ?? 0) + delta);
}

/** Creates the lot a mint brings into existence, with policy-derived deadlines. */
function planLot(
  work: Working,
  policy: LottedCurrencyPolicy,
  ownerUserId: number,
  source: LotSource,
  amount: number,
  now: Date,
): LotPointer {
  const ref = work.lots.length;
  const cancellable =
    policy.cancellationDays !== null && policy.cancellableSources.includes(source);
  work.lots.push({
    ref,
    currency: policy.code,
    ownerUserId,
    source,
    originalAmount: amount,
    mintedAt: now,
    validUntil: addDays(now, policy.lifetimeDays),
    cancellableUntil: cancellable ? addDays(now, policy.cancellationDays ?? 0) : null,
  });
  return { kind: 'PLANNED', ref };
}

/** The shared body of MINT and the mint half of SWAP. */
function planMint(
  work: Working,
  world: LedgerWorld,
  policies: CurrencyRegistry,
  args: {
    to: Holder;
    target: MintTarget;
    reason: string;
    op: 'MINT' | 'SWAP_MINT';
    swapRef: number | null;
    externalRef: string | null;
  },
  now: Date,
): void {
  const { to, target } = args;
  assertPositiveAmount(target.amount);
  const policy = policies[target.currency];
  if (!(policy.mintReasons as readonly string[]).includes(args.reason)) {
    throw new LedgerReasonNotAllowedError(target.currency, 'mint', args.reason);
  }
  assertHoldable(policy, to);
  const key = touchHolder(work, world, to);

  let lot: LotPointer | null = null;
  if (policy.kind === 'LOTTED') {
    if (target.source === null) throw new LedgerPolicyMismatchError(target.currency);
    if (!isPersonalHolder(to)) {
      // Unreachable through `MINT_SHAPES`; kept as the structural guard that a
      // lot always has an owner.
      throw new LedgerMovementNotAllowedError(args.reason, null, to.kind);
    }
    lot = planLot(work, policy, to.userId, target.source, target.amount, now);
    shiftLotBalance(work, world, lot, key, policy.code, target.amount);
  }

  shiftBalance(work, world, key, target.currency, target.amount);
  shiftSupply(work, target.currency, target.amount);
  work.events.push({
    ordinal: work.events.length,
    op: args.op,
    currency: target.currency,
    amount: target.amount,
    lot,
    fromHolderKey: null,
    toHolderKey: key,
    reason: args.reason,
    swapRef: args.swapRef,
    feeKrw: 0,
    externalRef: args.externalRef,
  });
}

/** The shared body of BURN and the burn half of SWAP. */
function planBurn(
  work: Working,
  world: LedgerWorld,
  policies: CurrencyRegistry,
  args: {
    from: Holder;
    tokens: readonly Token[];
    reason: string;
    op: 'BURN' | 'SWAP_BURN';
    swapRef: number | null;
    feeKrw: number;
    externalRef: string | null;
    lotRule: 'INTACT' | 'DUE' | null;
  },
  now: Date,
): void {
  // A burn of nothing is not a movement, and a fee riding on it would be cash
  // leaving the ledger with no event to explain it. One currency, for the same
  // reason `planSwap` demands it: the burn's policy checks must be unambiguous.
  soleCurrencyOf(args.tokens, args.reason);
  const key = touchHolder(work, world, args.from);
  let feeLeft = args.feeKrw;
  for (const token of args.tokens) {
    assertPositiveAmount(token.amount);
    const policy = policies[token.currency];
    if (!(policy.burnReasons as readonly string[]).includes(args.reason)) {
      throw new LedgerReasonNotAllowedError(token.currency, 'burn', args.reason);
    }
    assertHoldable(policy, args.from);

    if (token.lotId !== null) {
      const lot = world.lots.find((row) => row.id === token.lotId);
      if (!lot) throw new LedgerInsufficientBalanceError(key, token.currency, 0, token.amount);
      const held =
        world.lotBalances.find((row) => row.lotId === lot.id && row.holderKey === key)?.amount ?? 0;
      if (args.lotRule === 'INTACT') {
        if (held !== lot.originalAmount || token.amount !== lot.originalAmount) {
          throw new LedgerLotNotCancellableError(lot.id, 'ALREADY_SPENT');
        }
        if (lot.cancellableUntil === null || now.getTime() > lot.cancellableUntil.getTime()) {
          throw new LedgerLotNotCancellableError(lot.id, 'WINDOW_CLOSED');
        }
      }
      if (args.lotRule === 'DUE' && now.getTime() <= lot.validUntil.getTime()) {
        throw new LedgerLotNotDueError(lot.id);
      }
      shiftLotBalance(work, world, { kind: 'EXISTING', lotId: lot.id }, key, lot.currency, -token.amount);
    }

    shiftBalance(work, world, key, token.currency, -token.amount);
    shiftSupply(work, token.currency, -token.amount);
    // The cash rides on the first event of the burn, so summing `feeKrw` over
    // events counts it once.
    const fee = feeLeft;
    feeLeft = 0;
    work.events.push({
      ordinal: work.events.length,
      op: args.op,
      currency: token.currency,
      amount: token.amount,
      lot: token.lotId === null ? null : { kind: 'EXISTING', lotId: token.lotId },
      fromHolderKey: key,
      toHolderKey: null,
      reason: args.reason,
      swapRef: args.swapRef,
      feeKrw: fee,
      externalRef: args.externalRef,
    });
  }
}

/**
 * What cash this burn carries out, by the shape's own rule: computed from the
 * redeem policy, taken from the caller, or refused.
 *
 * The fee is a decision, so it lives here and not in the shell — a payout screen
 * that shows a number and a burn that charges a different one is the failure
 * this closes.
 */
function burnFee(
  policies: CurrencyRegistry,
  cash: 'REDEEM_FEE' | 'PRICE' | null,
  op: Extract<Op, { op: 'BURN' }>,
): number {
  const supplied = op.feeKrw ?? 0;
  if (cash === null) {
    if (supplied !== 0) throw new LedgerFeeNotAllowedError(op.reason, 'this burn carries no cash');
    return 0;
  }
  if (cash === 'PRICE') {
    if (!Number.isInteger(supplied) || supplied <= 0) {
      throw new LedgerFeeNotAllowedError(op.reason, 'a purchase must name what it cost');
    }
    return supplied;
  }
  if (op.feeKrw !== undefined) {
    throw new LedgerFeeNotAllowedError(op.reason, 'the redeem policy decides this fee');
  }
  const currency = soleCurrencyOf(op.tokens, op.reason);
  const policy = policies[currency];
  if (policy.redeem === null) {
    throw new LedgerFeeNotAllowedError(op.reason, `${currency} cannot become cash`);
  }
  const total = op.tokens.reduce((sum, token) => sum + token.amount, 0);
  return redeemFee(policy.redeem, total);
}

function planMove(
  work: Working,
  world: LedgerWorld,
  policies: CurrencyRegistry,
  op: Extract<Op, { op: 'MOVE' }>,
): void {
  const shape = MOVE_SHAPES[op.reason];
  if (
    !(shape.from as readonly HolderKind[]).includes(op.from.kind) ||
    !(shape.to as readonly HolderKind[]).includes(op.to.kind)
  ) {
    throw new LedgerMovementNotAllowedError(op.reason, op.from.kind, op.to.kind);
  }
  const fromKey = touchHolder(work, world, op.from);
  const toKey = touchHolder(work, world, op.to);

  if ('redeemable' in shape) {
    // A payout below the floor is refused HERE, where the money leaves the
    // wallet, rather than at the bank burn — a person must not watch value sit
    // in a payable account only to be told it was always too small to send.
    const currency = soleCurrencyOf(op.tokens, op.reason);
    const redeem = policies[currency].redeem;
    const total = op.tokens.reduce((sum, token) => sum + token.amount, 0);
    if (redeem !== null && total < redeem.minimumAmount) {
      throw new LedgerBelowPayoutMinimumError(currency, total, redeem.minimumAmount);
    }
  }

  for (const token of op.tokens) {
    assertPositiveAmount(token.amount);
    const policy = policies[token.currency];
    if (!policy.moveReasons.includes(op.reason)) {
      throw new LedgerReasonNotAllowedError(token.currency, 'move', op.reason);
    }
    assertHoldable(policy, op.from);
    assertHoldable(policy, op.to);
    if ('redeemable' in shape && policy.redeem === null) {
      throw new LedgerMovementNotAllowedError(op.reason, op.from.kind, op.to.kind);
    }

    if (token.lotId !== null) {
      const lot = world.lots.find((row) => row.id === token.lotId);
      if (!lot) throw new LedgerInsufficientBalanceError(fromKey, token.currency, 0, token.amount);
      if ('redeemable' in shape && policy.redeem?.excludeLotSources.includes(lot.source)) {
        throw new LedgerLotNotRedeemableError(lot.id, lot.source);
      }
      const pointer: LotPointer = { kind: 'EXISTING', lotId: lot.id };
      // Law L4: the SAME lot lands on the other side, so its deadlines and its
      // funding source survive the trip.
      shiftLotBalance(work, world, pointer, fromKey, lot.currency, -token.amount);
      shiftLotBalance(work, world, pointer, toKey, lot.currency, token.amount);
    }

    shiftBalance(work, world, fromKey, token.currency, -token.amount);
    shiftBalance(work, world, toKey, token.currency, token.amount);
    work.events.push({
      ordinal: work.events.length,
      op: 'MOVE',
      currency: token.currency,
      amount: token.amount,
      lot: token.lotId === null ? null : { kind: 'EXISTING', lotId: token.lotId },
      fromHolderKey: fromKey,
      toHolderKey: toKey,
      reason: op.reason,
      swapRef: null,
      feeKrw: 0,
      externalRef: null,
    });
  }
}

function planSwap(
  work: Working,
  world: LedgerWorld,
  policies: CurrencyRegistry,
  op: Extract<Op, { op: 'SWAP' }>,
  now: Date,
): void {
  const rate = SWAP_RATES[op.rate];
  // One header per burn currency: an escrow holding two kinds of point settles
  // as two swaps, so `LedgerSwap.burnCurrency` is never a half-truth.
  const burnCurrency = soleCurrencyOf(op.tokens, op.rate);
  if (!(rate.from as readonly Currency[]).includes(burnCurrency)) {
    throw new LedgerSwapNotAllowedError(op.rate, `${burnCurrency} is not an input of this rate`);
  }
  if (
    !(rate.fromKinds as readonly HolderKind[]).includes(op.from.kind) ||
    !(rate.toKinds as readonly HolderKind[]).includes(op.to.kind)
  ) {
    throw new LedgerMovementNotAllowedError(op.rate, op.from.kind, op.to.kind);
  }

  const burnTotal = op.tokens.reduce((sum, token) => sum + token.amount, 0);
  // Law L2: the fee is the difference between what was destroyed and what was
  // created, and the rebate IS the fee. Computed here, never supplied — a
  // caller cannot mint more than it burned.
  //
  // Rounded DOWN, which is what makes the exchange total: at a 10% rate a
  // one-unit remainder costs nothing and exchanges for one, so a SPLIT that
  // leaves a single point behind can still be settled. Rounding up would make
  // the fee eat the whole thing and strand it in the escrow forever.
  const feeKrw = Math.floor((burnTotal * rate.feePermille) / 1000);
  const mintAmount = burnTotal - feeKrw;
  if (mintAmount <= 0) {
    throw new LedgerSwapNotAllowedError(op.rate, 'the fee consumes the whole exchange');
  }

  const ref = work.swaps.length;
  work.swaps.push({
    ref,
    rateKind: op.rate,
    burnCurrency,
    mintCurrency: rate.to,
    feePermille: rate.feePermille,
    feeKrw,
  });

  planBurn(
    work,
    world,
    policies,
    {
      from: op.from,
      tokens: op.tokens,
      reason: op.rate,
      op: 'SWAP_BURN',
      swapRef: ref,
      feeKrw,
      externalRef: op.externalRef ?? null,
      lotRule: null,
    },
    now,
  );

  const mintCurrency = rate.to;
  let mintTarget: MintTarget;
  if (isLottedCurrency(mintCurrency)) {
    if (rate.mintLotSource === null) throw new LedgerPolicyMismatchError(mintCurrency);
    mintTarget = { currency: mintCurrency, amount: mintAmount, source: rate.mintLotSource };
  } else {
    mintTarget = { currency: mintCurrency, amount: mintAmount, source: null };
  }
  planMint(
    work,
    world,
    policies,
    { to: op.to, target: mintTarget, reason: op.rate, op: 'SWAP_MINT', swapRef: ref, externalRef: null },
    now,
  );

  // The rebate hands the fee straight back in the loyalty currency, so "what we
  // charged" and "what we granted" are one number by construction (law L2).
  const rebateCurrency = rate.rebate;
  if (rebateCurrency !== null && feeKrw > 0) {
    if (isLottedCurrency(rebateCurrency)) throw new LedgerPolicyMismatchError(rebateCurrency);
    planMint(
      work,
      world,
      policies,
      {
        to: op.rebateTo ?? op.to,
        target: { currency: rebateCurrency, amount: feeKrw, source: null },
        reason: op.rate,
        op: 'SWAP_MINT',
        swapRef: ref,
        externalRef: null,
      },
      now,
    );
  }
}

/**
 * Decides one posting: validates every operation against the currency policies
 * and the movement laws, then returns the complete set of writes.
 *
 * This is where L1 through L7 are enforced (L8 is the unique index the shell
 * writes through); they are defined once at the top of this file.
 *
 * Total: returns a plan or throws a `DomainError` (the caller's fault) or one of
 * the two masked corruption errors (ours).
 */
export function planPosting(
  world: LedgerWorld,
  posting: Posting,
  policies: CurrencyRegistry,
  now: Date,
): PostingPlan {
  if (posting.referenceId !== world.reference.id) {
    throw new LedgerWorldMismatchError(posting.referenceId, world.reference.id);
  }
  if (world.reference.state === 'CLOSED') {
    throw new LedgerReferenceClosedError(world.reference.id);
  }

  const work: Working = {
    balances: new Map(),
    balanceAssumed: new Map(),
    lotBalances: new Map(),
    lotBalanceAssumed: new Map(),
    holders: new Map(),
    lots: [],
    swaps: [],
    events: [],
    supplyDelta: new Map(),
  };

  for (const op of posting.ops) {
    switch (op.op) {
      case 'MINT': {
        const shape = MINT_SHAPES[op.reason];
        if (!(shape.to as readonly HolderKind[]).includes(op.to.kind)) {
          throw new LedgerMovementNotAllowedError(op.reason, null, op.to.kind);
        }
        planMint(
          work,
          world,
          policies,
          {
            to: op.to,
            target: op.target,
            reason: op.reason,
            op: 'MINT',
            swapRef: null,
            externalRef: op.externalRef ?? null,
          },
          now,
        );
        break;
      }
      case 'BURN': {
        const shape = BURN_SHAPES[op.reason];
        if (!(shape.from as readonly HolderKind[]).includes(op.from.kind)) {
          throw new LedgerMovementNotAllowedError(op.reason, op.from.kind, null);
        }
        const feeKrw = burnFee(policies, shape.cash, op);
        planBurn(
          work,
          world,
          policies,
          {
            from: op.from,
            tokens: op.tokens,
            reason: op.reason,
            op: 'BURN',
            swapRef: null,
            feeKrw,
            externalRef: op.externalRef ?? null,
            lotRule: shape.lot,
          },
          now,
        );
        break;
      }
      case 'MOVE':
        planMove(work, world, policies, op);
        break;
      default:
        planSwap(work, world, policies, op, now);
    }
  }

  const balanceWrites: BalanceWrite[] = [];
  const balanceDelta = new Map<Currency, number>();
  const perHolderDelta = new Map<string, number>();
  for (const [cell, assumed] of work.balanceAssumed) {
    const separator = cell.lastIndexOf('|');
    const key = cell.slice(0, separator);
    const currency = cell.slice(separator + 1) as Currency;
    const after = work.balances.get(cell) ?? 0;
    const delta = after - (assumed ?? 0);
    balanceWrites.push({ holderKey: key, currency, assumed, after });
    balanceDelta.set(currency, (balanceDelta.get(currency) ?? 0) + delta);
    if (isLottedCurrency(currency)) perHolderDelta.set(cell, delta);
  }

  const lotBalanceWrites: LotBalanceWrite[] = [];
  const perHolderLotDelta = new Map<string, number>();
  for (const [cell, assumed] of work.lotBalanceAssumed) {
    const separator = cell.indexOf('|');
    const lotCellId = cell.slice(0, separator);
    const key = cell.slice(separator + 1);
    const after = work.lotBalances.get(cell) ?? 0;
    const pointer: LotPointer = lotCellId.startsWith('E')
      ? { kind: 'EXISTING', lotId: Number(lotCellId.slice(1)) }
      : { kind: 'PLANNED', ref: Number(lotCellId.slice(1)) };
    lotBalanceWrites.push({ lot: pointer, holderKey: key, assumed, after });
    const currency =
      pointer.kind === 'PLANNED'
        ? work.lots[pointer.ref]!.currency
        : world.lots.find((row) => row.id === pointer.lotId)!.currency;
    const bucket = balanceCell(key, currency);
    perHolderLotDelta.set(bucket, (perHolderLotDelta.get(bucket) ?? 0) + (after - (assumed ?? 0)));
  }

  // Law L1 — value is conserved: what the balances gained is exactly what was
  // minted less what was burned. A MOVE contributes nothing to either side.
  for (const currency of new Set([...balanceDelta.keys(), ...work.supplyDelta.keys()])) {
    const supply = work.supplyDelta.get(currency) ?? 0;
    const balance = balanceDelta.get(currency) ?? 0;
    if (supply !== balance) throw new LedgerConservationError(currency, supply, balance);
  }

  // Lot coherence — for a lotted currency the parcels must move exactly as much
  // as the balance they sum to.
  for (const [cell, delta] of perHolderDelta) {
    const lotDelta = perHolderLotDelta.get(cell) ?? 0;
    if (delta !== lotDelta) {
      const separator = cell.lastIndexOf('|');
      throw new LedgerLotCoherenceError(
        cell.slice(0, separator),
        cell.slice(separator + 1) as Currency,
        delta,
        lotDelta,
      );
    }
  }

  const reference = planReferenceTransition(world, posting, work, balanceWrites, now);

  return {
    referenceId: posting.referenceId,
    idempotencyKey: posting.idempotencyKey,
    actor: posting.actor,
    now,
    holdersToCreate: [...work.holders.values()],
    lotsToCreate: work.lots,
    swapsToCreate: work.swaps,
    events: work.events,
    balanceWrites,
    lotBalanceWrites,
    reference,
  };
}

/**
 * Decides the flow's lifecycle move. OPEN becomes FUNDED the moment value moves
 * under it; CLOSED requires the caller to declare a reason AND the reference's
 * own holders to be empty — law L3, which is what makes "no money is stranded in
 * a finished order" a checkable property rather than a hope.
 */
function planReferenceTransition(
  world: LedgerWorld,
  posting: Posting,
  work: Working,
  balanceWrites: readonly BalanceWrite[],
  now: Date,
): ReferenceWrite {
  const moved = work.events.length > 0;
  const funded = world.reference.state === 'FUNDED' || moved;

  // The reference's OWN accounts: the escrow / payable rows that already exist,
  // plus any this posting brings into being.
  const referenceKeys = new Set(world.referenceHolderKeys);
  for (const holder of work.holders.values()) {
    if (holder.referenceId === world.reference.id) referenceKeys.add(holder.key);
  }

  const writes = new Map(
    balanceWrites.map((write) => [balanceCell(write.holderKey, write.currency), write] as const),
  );
  let heldBefore = 0;
  let heldAfter = 0;
  const counted = new Set<string>();
  for (const row of world.balances) {
    if (!referenceKeys.has(row.holderKey)) continue;
    const cell = balanceCell(row.holderKey, row.currency);
    counted.add(cell);
    heldBefore += row.amount;
    heldAfter += writes.get(cell)?.after ?? row.amount;
  }
  for (const [cell, write] of writes) {
    if (counted.has(cell) || !referenceKeys.has(write.holderKey)) continue;
    heldBefore += write.assumed ?? 0;
    heldAfter += write.after;
  }

  if (posting.closeAs === undefined) {
    // A flow that just gave up the last of its value has ended; it does not get
    // to end anonymously, because "settled" and "reversed" are the same zero.
    if (heldBefore > 0 && heldAfter === 0) {
      throw new LedgerCloseReasonRequiredError(world.reference.id);
    }
    return {
      assumedState: world.reference.state,
      nextState: funded ? 'FUNDED' : world.reference.state,
      closeReason: null,
      closedAt: null,
    };
  }

  // VOID is the claim that nothing ever moved under this flow, so it is refused
  // both for a posting that moves value and for a flow already FUNDED — which,
  // by the transition rule above, is exactly what "value has moved" means.
  if (posting.closeAs === 'VOID' && (moved || world.reference.state === 'FUNDED')) {
    throw new LedgerVoidNotEmptyError(world.reference.id);
  }
  // Law L3 — nothing is stranded in a finished flow.
  if (heldAfter > 0) throw new LedgerCloseNotEmptyError(world.reference.id, heldAfter);
  return {
    assumedState: world.reference.state,
    nextState: 'CLOSED',
    closeReason: posting.closeAs,
    closedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The sweeps' decisions
// ---------------------------------------------------------------------------

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
