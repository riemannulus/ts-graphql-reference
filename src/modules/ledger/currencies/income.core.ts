import type { ScalarCurrencyPolicy } from '../ledger.policy.core.js';

/**
 * Income — what a seller has earned and we owe them. `PAYABLE` in the books,
 * and the only currency whose accounting class says the money is theirs.
 *
 * Scalar, not lotted: earnings have no expiry, no funding source to return to,
 * and no cooling-off window, so parcelling them would buy nothing but rows.
 * That is the whole content of the lotted/scalar split — it is about whether the
 * currency has per-parcel facts, not about how it is spelled.
 *
 * `holderKinds` omits `ESCROW`. Income is created by a settlement, which is the
 * moment an order's escrow EMPTIES; income sitting in an escrow would mean an
 * order had settled and not settled at once. Excluding the holder kind makes
 * that unrepresentable rather than merely unwritten.
 *
 * `redeem` has a zero fee because the cut was already taken at settlement
 * (`SWAP_RATES.SETTLE`). Charging again at payout would be the same fee twice —
 * the failure mode of a system where the two are separate features, and here
 * they cannot drift apart because the fee has exactly one home. What was taken
 * there is recorded as cash and handed straight back as loyalty value, so the
 * platform's economics are a liability owed rather than revenue booked; that
 * is a fact about the rate, and it does not change the rule here, which is
 * simply that a payout takes nothing further. What
 * remains is `minimumAmount`: a payout below the bank's own per-transfer cost is
 * refused, not silently absorbed.
 */
export const INCOME_POLICY: ScalarCurrencyPolicy = {
  kind: 'SCALAR',
  code: 'INCOME',
  accounting: 'PAYABLE',
  holderKinds: ['USER', 'PAYABLE', 'RECEIVABLE'],
  mintReasons: ['SETTLE', 'ADMIN_GRANT', 'LOSS_RECOGNITION', 'OPENING'],
  burnReasons: ['POINT_CONVERSION', 'BANK_WITHDRAWAL', 'ADMIN_REVOKE'],
  moveReasons: ['PAYOUT_STAKE', 'PAYOUT_UNSTAKE', 'CLAWBACK', 'CLAWBACK_RELEASE'],
  redeem: {
    feePermille: 0,
    minimumFee: 0,
    minimumAmount: 9000,
    excludeLotSources: [],
  },
};
