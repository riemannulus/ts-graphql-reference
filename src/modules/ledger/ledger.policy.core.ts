import {
  type Currency,
  type HolderKind,
  type LotSource,
  type LottedCurrency,
  parseMember,
  type ScalarCurrency,
} from './ledger.value.js';

/**
 * The rules the kernel decides AGAINST, as data.
 *
 * Which reasons exist; which accounts a movement of each reason may run between
 * (law L5, as four tables rather than a pile of conditionals); which currency
 * exchanges exist at all; and what each currency permits. The planner reads all
 * of it and supplies the arithmetic.
 *
 * Two functions come along, and only because they belong to the tables rather
 * than to the algorithm: `redeemFee` reads a rate off a policy, and
 * `parseSwapRateKind` reads a rate kind back off a database row.
 *
 * They live together because they are one subject — the movement rules — and
 * apart from the planner because a table is reviewed differently from an
 * algorithm: a reader checking "may a gift be staked from free points?" should
 * find the answer by reading a list, not by following control flow. It is also
 * what keeps `ledger.core.ts` free of currency names: the per-currency half
 * arrives as `CurrencyPolicy` values from `currencies/`, injected at the
 * composition root.
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
export const MOVE_SHAPES = {
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
export const MINT_SHAPES = {
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
export const BURN_SHAPES = {
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
    samePerson: false,
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
    samePerson: false,
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
    samePerson: true,
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
    /**
     * Whether both ends must belong to the SAME person.
     *
     * The two cross-person edges run out of an escrow, so the value they hand
     * over was staked into a flow that can still reverse it. An edge that runs
     * wallet to wallet has no such flow, and without this it would be a
     * person-to-person transfer wearing an exchange's name — the exact thing
     * `MOVE_SHAPES` refuses by having no `USER → USER` shape at all.
     */
    samePerson: boolean;
    rebate: Currency | null;
    mintLotSource: LotSource | null;
    feePermille: number;
  }
>;

export type SwapRateKind = keyof typeof SWAP_RATES;
export type SwapRate = (typeof SWAP_RATES)[SwapRateKind];

/** What one exchange destroys, creates, and charges. */
export interface SwapSplit {
  readonly feeKrw: number;
  readonly mintAmount: number;
}

/**
 * Law L2, as arithmetic: an exchange creates exactly what it destroyed, less
 * the fee. Both numbers are computed from the rate and never supplied, so a
 * caller cannot mint more than it burned.
 *
 * The fee rounds DOWN, which is what makes every exchange representable: at a
 * 10% rate a one-unit remainder costs nothing and exchanges for one, so a SPLIT
 * that leaves a single point behind can still be settled. Rounding up would let
 * the fee eat the whole thing and strand it in the escrow forever.
 *
 * It lives beside `SWAP_RATES` rather than in the planner because `feePermille`
 * is the only input it reads, and a rate whose arithmetic sits three hundred
 * lines away is a rate whose rounding nobody checks when the rate changes.
 * Returns `null` when the fee would consume the exchange; the caller decides
 * what to say about that.
 */
export function swapSplit(rate: SwapRate, burnTotal: number): SwapSplit | null {
  const feeKrw = Math.floor((burnTotal * rate.feePermille) / 1000);
  const mintAmount = burnTotal - feeKrw;
  return mintAmount <= 0 ? null : { feeKrw, mintAmount };
}
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
