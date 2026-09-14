# ADR 0002: Separate commission income settlement from withdrawal

## Status

Accepted for the commission income PoC.

## Context

Commission completion does not immediately send money to a bank account. It
converts held POINT into the worker's withdrawable INCOME. A later withdrawal
may combine INCOME earned from several commissions. Treating both moments as one
transaction would either attach one commission flow to a multi-commission bank
payout or lose the commission-level source amounts.

## Decision

Keep settlement on the existing COMMISSION flow. A SETTLE operation owns one
SWAP with a POINT leg and an INCOME leg at an explicit quote. The resulting
INCOME lot has the SETTLE operation and COMMISSION flow as immutable provenance.

Create a separate WITHDRAWAL flow when the worker requests payout. Its WITHDRAW
operation allocates INCOME lots and moves their value from AVAILABLE to a
withdrawal-specific hold. Those allocations form the amount-level mapping from
one withdrawal back to every source COMMISSION flow.

The PoC quote is 1 POINT to 1 INCOME and the result is immediately available.
These are explicit policy choices. A later hold period adds a PENDING account
and RELEASE operation, and a later bank integration groups withdrawal flows in
a PayoutBatch; neither changes the provenance chain.

## Consequences

Commission settlement can be retried without minting INCOME twice. Withdrawal
can combine commissions without making a financial operation belong to more
than one flow. Finance can reconcile an external payout through withdrawal
allocations to the exact commission amounts.

The ledger now needs Currency-typed accounts, generic lots, and a structurally
typed SWAP action. Production adoption must decide whether INCOME is a distinct
unit or a KRW-denominated instrument and add fee, tax, quote, payout-failure,
and reversal policies before replacing the fixed PoC assumptions.
