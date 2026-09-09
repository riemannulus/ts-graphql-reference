import type { ScalarCurrencyPolicy } from '../ledger.core.js';

/**
 * Mileage — loyalty value, handed back as the rebate on every fee the platform
 * takes (`SWAP_RATES.SETTLE`). A `PROVISION`: a liability we created by
 * promising something, redeemable only inside the store.
 *
 * This is the currency defined by what it CANNOT do, and each restriction is a
 * missing entry rather than a guard:
 *
 * - `redeem: null` and no `PAYABLE` holder — it never becomes cash.
 * - `moveReasons: []` — it never changes hands at all. No stake, no gift, not
 *   even a clawback: mileage that was granted stays granted.
 * - `holderKinds: ['USER']` — it exists only in a person's wallet, so there is
 *   no escrow to strand it in and no receivable to write it off against.
 * - No outgoing edge in `SWAP_RATES` — `SwapRateFor<'MILEAGE', …>` is `never`,
 *   so "exchange mileage for anything" does not compile.
 *
 * Four independent statements of one policy, none of which is a runtime check
 * someone can forget to call. The only way out is `STORE_PURCHASE`, which burns
 * it and moves the cash to the store's books.
 */
export const MILEAGE_POLICY: ScalarCurrencyPolicy = {
  kind: 'SCALAR',
  code: 'MILEAGE',
  accounting: 'PROVISION',
  holderKinds: ['USER'],
  mintReasons: ['EVENT', 'ADMIN_GRANT', 'OPENING'],
  burnReasons: ['STORE_PURCHASE', 'ADMIN_REVOKE'],
  moveReasons: [],
  redeem: null,
};
