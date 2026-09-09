import { addDays } from '../../foundation/time.js';
import {
  type Currency,
  type Holder,
  holderKey,
  type HolderKind,
  isLottedCurrency,
  isPersonalHolder,
  type LotSource,
  type LottedCurrency,
} from './ledger.value.js';
import {
  LedgerAmountNotPositiveError,
  LedgerBelowPayoutMinimumError,
  LedgerCloseNotEmptyError,
  LedgerCloseReasonRequiredError,
  LedgerConservationError,
  LedgerCurrencyNotHoldableError,
  LedgerFeeNotAllowedError,
  LedgerForeignHolderError,
  LedgerInsufficientBalanceError,
  LedgerLotCoherenceError,
  LedgerLotNotCancellableError,
  LedgerLotNotDueError,
  LedgerLotNotRedeemableError,
  LedgerMovementNotAllowedError,
  LedgerPolicyMismatchError,
  LedgerReasonNotAllowedError,
  LedgerReferenceClosedError,
  LedgerSwapNotAllowedError,
  LedgerTokenCurrencyError,
  LedgerVoidNotEmptyError,
  LedgerWorldMismatchError,
} from './ledger.errors.core.js';
import {
  BURN_SHAPES,
  type CurrencyPolicy,
  type CurrencyRegistry,
  type LottedCurrencyPolicy,
  MINT_SHAPES,
  MOVE_SHAPES,
  redeemFee,
  SWAP_RATES,
  swapSplit,
} from './ledger.policy.core.js';
import type {
  BalanceWrite,
  LedgerWorld,
  LotBalanceWrite,
  LotPointer,
  MintTarget,
  Op,
  PlannedEvent,
  PlannedHolder,
  PlannedLot,
  PlannedSwap,
  Posting,
  PostingPlan,
  ReferenceWrite,
  Token,
} from './ledger.plan.core.js';

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
 * ## What lives where
 *
 * This file is the ALGORITHM and nothing else. The declarations it decides
 * against were split out, so that reading a rule and reading the code that
 * applies it are separate acts:
 *
 * - `ledger.value.ts` — the vocabulary: currencies, holders, reference ids.
 * - `ledger.policy.core.ts` — the rules as tables: which reasons exist, which
 *   accounts each may run between, which exchanges exist, what each currency
 *   permits.
 * - `ledger.plan.core.ts` — the contract with the shell: what a caller asks
 *   for, what the kernel reads, what it returns.
 * - `ledger.errors.core.ts` — the refusals and corruptions planning can raise.
 * - `ledger.sweep.core.ts` — the scheduled sweeps' own small decisions.
 *
 * ## Currency-agnostic by construction
 *
 * This file names no currency. Policies (`CurrencyPolicy`) arrive as DATA — the
 * weakest rung of the coupling ladder — so adding a currency is a new file under
 * `currencies/`, never an edit here, and WHICH currencies exist is decided in
 * the composition root. The two policy SHAPES (lotted / scalar) are a
 * discriminated union rather than a class hierarchy: what a lotted currency
 * "inherits" is written ONCE and keyed off `policy.kind`, never per currency.
 * Which file holds each piece follows what it is for — the cancellation window
 * and a lot's deadlines are decided while planning and live here; choosing lots
 * to spend is something a CALLER does (`ledger.plan.core.ts`); finding the ones
 * past their deadline is a sweep's job (`ledger.sweep.core.ts`).
 *
 * ## The laws
 *
 * Everything here serves these. They are numbered because the rest of the
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
 * gets charged at whichever happened to be listed first.
 *
 * Demanded at EVERY burn and every redeemable move besides, not only where a
 * number is computed: one burn is one currency, so the rule is a property of
 * the operation rather than of the branch that happens to need it. A mixed
 * operation is not forbidden as a matter of taste — it is two operations, and
 * saying so costs a caller one more entry in `ops`.
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
  // A move of nothing is not a movement. Checked for EVERY move, not only the
  // redeemable ones below, so an empty `tokens` is refused rather than planning
  // silently to do nothing.
  soleCurrencyOf(op.tokens, op.reason);
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
  if (rate.samePerson) {
    // An impersonal end is refused rather than skipped: "the same person" has
    // no meaning for an escrow, so a future edge that paired this flag with one
    // would silently get no rule at all.
    if (!isPersonalHolder(op.from) || !isPersonalHolder(op.to)) {
      throw new LedgerSwapNotAllowedError(op.rate, 'both sides must be a person');
    }
    if (op.from.userId !== op.to.userId) {
      throw new LedgerSwapNotAllowedError(op.rate, 'both sides must be the same person');
    }
  }

  const burnTotal = op.tokens.reduce((sum, token) => sum + token.amount, 0);
  // Law L2 is the rate's arithmetic, so it lives with the rate. The rebate that
  // hands this fee back is planned below, which is what keeps "what we charged"
  // and "what we granted" one number.
  const split = swapSplit(rate, burnTotal);
  if (split === null) {
    throw new LedgerSwapNotAllowedError(op.rate, 'the fee consumes the whole exchange');
  }
  const { feeKrw, mintAmount } = split;

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
