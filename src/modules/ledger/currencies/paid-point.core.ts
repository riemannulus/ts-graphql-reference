import type { LottedCurrencyPolicy } from '../ledger.core.js';

/**
 * Paid points — value a person bought with money.
 *
 * The only point currency that can become cash again, which is what every rule
 * below is about. It is `DEFERRED_REVENUE`: the money is ours to hold, not ours
 * to keep, until the value is spent or returned.
 *
 * Two windows govern a lot, and they are deliberately different mechanisms:
 *
 * - `cancellationDays` is the statutory cooling-off return, and it applies only
 *   to lots funded through the payment gateway (`cancellableSources`). Store
 *   purchases are cancelled at the store, and value converted out of income was
 *   never a cash payment, so neither can be unwound through us.
 * - `lifetimeDays` is when an unspent lot dies. Five years is the retention the
 *   accounting side assumes; because it is per LOT and not per wallet, spending
 *   oldest-first (`selectLotsFifo`) is what keeps value from expiring in a
 *   wallet that had plenty to spend.
 *
 * `excludeLotSources` is the interesting half of `redeem`. Value bought through
 * an app store is refunded BY that store, so paying it out through our bank
 * account would make their refund unreconcilable; value converted from income
 * must go back out through the income payout, which carries the tax identity
 * checks. Both stay perfectly spendable — they simply cannot leave this way, and
 * a payout that tries is refused by `LedgerLotNotRedeemableError` rather than by
 * a comment.
 */
export const PAID_POINT_POLICY: LottedCurrencyPolicy = {
  kind: 'LOTTED',
  code: 'PAID_POINT',
  accounting: 'DEFERRED_REVENUE',
  holderKinds: ['USER', 'ESCROW', 'PAYABLE', 'RECEIVABLE'],
  mintReasons: ['PG_CHARGE', 'IAP_CHARGE', 'ADMIN_GRANT', 'LOSS_RECOGNITION', 'OPENING'],
  burnReasons: [
    'PG_REFUND',
    'BANK_WITHDRAWAL',
    'EXPIRED',
    'IAP_REVOKE',
    'ADMIN_REVOKE',
    'STORE_PURCHASE',
  ],
  moveReasons: [
    'ORDER_STAKE',
    'ORDER_UNSTAKE',
    'GIFT_STAKE',
    'GIFT_UNSTAKE',
    'PAYOUT_STAKE',
    'PAYOUT_UNSTAKE',
    'CLAWBACK',
    'CLAWBACK_RELEASE',
  ],
  redeem: {
    feePermille: 100,
    minimumFee: 1000,
    minimumAmount: 1000,
    excludeLotSources: ['IAP', 'INCOME_SWAP'],
  },
  lifetimeDays: 365 * 5,
  cancellationDays: 7,
  cancellableSources: ['PG'],
};
