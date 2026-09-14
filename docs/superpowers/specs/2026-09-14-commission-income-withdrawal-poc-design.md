# Commission Income Settlement and Withdrawal PoC Design

## Question

Can the ledger settle a paid commission by swapping its escrowed POINT into a
withdrawable INCOME balance, then let one withdrawal consume INCOME originating
from several commissions while preserving an amount-level audit path back to
each `COMMISSION-<uuid>` flow?

## Scope and assumptions

- This remains a fresh-database, unmerged PoC. Existing production data and
  payment-provider integration are outside this slice.
- `INCOME` is an internal ledger Currency. The PoC fixes the quote at
  `1 POINT = 1 INCOME`; a production quote, fee, tax, and KRW denomination model
  are future policy inputs rather than implicit arithmetic.
- A commission becomes immediately withdrawable when it is settled. A future
  holding period adds an `INCOME/PENDING` account and a RELEASE operation; it
  does not change the lineage model.
- The PoC implements withdrawal reservation (`AVAILABLE → ESCROW`). Bank payout
  confirmation and payout batches are documented extension points, not external
  integrations.

## Domain boundaries

The existing `COMMISSION` flow remains the lifecycle of one commission. Its
SETTLE command creates a SETTLE operation and a structurally typed SWAP action.
The SWAP contains two conserved legs:

1. `POINT`: the commission reservation's ESCROW account to the platform's
   `POINT/SETTLED` account;
2. `INCOME`: the platform's `INCOME/ISSUER` account to the worker's
   `INCOME/AVAILABLE` account.

The INCOME output is a `FinancialLot` whose immutable source is the SETTLE
operation and commission flow. Existing POINT lots use the same generic model;
their source is a charge category rather than a financial operation.

A withdrawal owns a distinct `WITHDRAWAL` flow. Its WITHDRAW command creates a
WITHDRAW operation and TRANSFER action, allocates FIFO INCOME lots, decrements
their remaining amounts with optimistic guards, and moves the selected amount
from the worker's `INCOME/AVAILABLE` account to a reservation-owned
`INCOME/ESCROW` account. The allocation rows are the amount-level join between
the withdrawal and each source commission.

## Identities and policies

Public identifiers remain projections of persisted kinds:

- `COMMISSION-<uuid>` and `WITHDRAWAL-<uuid>` for flows;
- `CMD-SETTLE-<uuid>` and `OP-SETTLE-<uuid>` for commission settlement;
- `CMD-WITHDRAW-<uuid>` and `OP-WITHDRAW-<uuid>` for withdrawal reservation.

Each commission flow explicitly permits PAY and SETTLE. Each new withdrawal
flow permits only WITHDRAW. The existing `FlowCommandPolicy` composite foreign
key rejects a command that is not legal for its flow.

## Storage and invariants

`FinancialLot` replaces the POINT-only lot model. Its basis fields are
immutable. An INCOME lot must carry `sourceOperationId`, `sourceFlowId`, and
`sourceOperationKind = SETTLE`; a composite foreign key proves those values name
one persisted SETTLE operation. Its account must have the same Currency.

`FinancialTransfer` becomes Currency-explicit. Composite foreign keys require
both accounts and every allocated lot to use that Currency, and require an
allocation's lot to belong to the transfer's source account. Conservation still
requires transfer amount = allocation sum.

`FinancialSwapAction` and its two `FinancialSwapLeg` rows are append-only. A
deferred PostgreSQL constraint requires exactly one POINT leg and one INCOME
leg with equal positive amounts. Both legs share the action's commission
`flowId`; account/Currency composite foreign keys prevent mislabeled legs.

Commission SETTLE is one-shot by unique source operation and reservation links.
It changes the reservation from HELD to SETTLED using a guarded update. A
repeated idempotency key returns the same operation; a different key for an
already settled commission records an alias command without another SWAP or
INCOME lot.

Withdrawal creation and reservation are one serialized transaction. A retry
with the same principal, kind, and key returns the same withdrawal result. An
insufficient or concurrently changed INCOME lot aborts the whole transaction.

## Module design

- `financial-ledger` remains the leaf owner of accounts, lots, reservations,
  transfers, allocations, and typed financial actions.
- `transaction-flow` remains the leaf owner of flow, policy, command, and
  operation identity. It creates an operation and completes its command without
  choosing an action subtype.
- `commission-settlement` is a composite use-case over contract/order facts,
  transaction-flow, and financial-ledger owner functions.
- `income-withdrawal` is a composite use-case over transaction-flow and
  financial-ledger owner functions and owns the withdrawal request row.

Both composite services follow read → pure plan → mechanical apply and pass one
transaction handle directly to owner repos. No owner imports either composite.

## API surface

The GraphQL PoC adds:

- `settleCommission(input: { contractId, actorId, commandKey })`;
- `requestIncomeWithdrawal(input: { actorId, amount, commandKey })`.

Each result returns its flow reference, command id, operation id, economic row
ids, and `replayed`.

## Audit queries and later payout

The implemented audit path is:

`WITHDRAWAL flow → transfer allocation → FinancialLot → OP-SETTLE → COMMISSION flow`.

A later bank integration adds `PayoutBatch` and `PayoutBatchItem` above completed
withdrawal flows. It records the external bank transaction on the batch and does
not attach one bank transaction directly to many commission flows. Failed or
reversed payouts append compensating operations instead of mutating financial
history.

## Verification

Unit tests pin both pure plans. Integration tests prove same-flow and
same-Currency constraints, SWAP leg shape, immutable source lineage,
idempotency, insufficient funds rollback, multi-commission withdrawal
allocation, and the reverse audit query. A real PostgreSQL test covers the
deferred SWAP constraint and concurrent withdrawal. Existing type, lint,
dependency graph, build, Prisma validation, migration drift, and full test
checks remain green.
