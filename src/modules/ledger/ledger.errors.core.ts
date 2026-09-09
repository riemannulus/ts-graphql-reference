import { DomainError } from '../../foundation/errors.js';
import type { Currency, HolderKind, LotSource } from './ledger.value.js';

/**
 * Every way the ledger refuses, in one place.
 *
 * Split from the kernel because a refusal is a fact about the DOMAIN, not about
 * the algorithm that happens to detect it: "a payout below the minimum" means
 * the same thing whether the planner, a future validator, or a shell check
 * raises it. Keeping them together also makes the two KINDS visible side by
 * side, which is the distinction that matters when reading them:
 *
 * - A `DomainError` is the caller's fault and is safe to show them. It says
 *   what the ledger will not do and why.
 * - A plain `Error` is OURS — a state a correct kernel cannot reach. It is
 *   MASKED at the edge rather than surfaced, because a client can do nothing
 *   with "the books do not balance" except lose confidence. These are the last
 *   line before a wrong number reaches the database.
 */

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
