import type { LottedCurrencyPolicy } from '../ledger.core.js';

/**
 * Free points — value the platform gave away: a top-up bonus, an event reward,
 * a redeemed gift.
 *
 * Structurally identical to paid points except in the two ways that matter, and
 * making them a SEPARATE currency rather than a second column on one balance is
 * the whole reason those differences are enforceable:
 *
 * - `redeem: null` and no `PAYABLE` in `holderKinds` — free value cannot become
 *   cash. Not "is not currently allowed to": there is no shape in which it
 *   reaches a bank account, because `PAYOUT_STAKE` demands a redeemable currency
 *   AND a payable holder, and this policy offers neither. A gift redeemed into
 *   free points therefore cannot be laundered into a withdrawal.
 * - No `PG_REFUND`. Value we never charged for cannot be returned to a card;
 *   when the paid charge it rode in on IS returned, the bonus dies alongside it
 *   (`FORFEIT_ON_REFUND`), which is a different fact and gets a different word.
 *
 * It is `PROVISION` in the books — a liability we created out of marketing
 * spend, not out of someone's payment.
 *
 * The lifetime matches paid points so that a wallet's value expires on one
 * schedule regardless of how it arrived; spend order across the two currencies
 * is the composite's choice (paid-first, free-first), made by which selection it
 * runs first, not by a flag buried in here.
 */
export const FREE_POINT_POLICY: LottedCurrencyPolicy = {
  kind: 'LOTTED',
  code: 'FREE_POINT',
  accounting: 'PROVISION',
  holderKinds: ['USER', 'ESCROW', 'RECEIVABLE'],
  mintReasons: [
    'GIFT_CARD_REDEEM',
    'PG_BONUS',
    'EVENT',
    'ADMIN_GRANT',
    'LOSS_RECOGNITION',
    'OPENING',
  ],
  burnReasons: [
    'SETTLE',
    'GIFT_CARD_REDEEM',
    'FORFEIT_ON_REFUND',
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
    'CLAWBACK',
    'CLAWBACK_RELEASE',
  ],
  redeem: null,
  lifetimeDays: 365 * 5,
  cancellationDays: null,
  cancellableSources: [],
};
