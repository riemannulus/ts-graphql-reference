# Ledger Checkout PoC Design

## Question

Can the proposed Crepe payment architecture be expressed in this repository as
a small set of deep modules while preserving one atomic commit across an Order,
a generic financial reservation, Contract formation, slot confirmation, and the
command result?

This is a throwaway proof of concept. Its value is the architectural result and
tests. It is not a production migration and must be deleted or absorbed after
the result is accepted.

## Scope

The PoC implements one persisted vertical path exposed as a GraphQL mutation:

1. Seed a commission type, an available slot, a buyer, and a funded POINT
   account through test fixtures.
2. Prepare an Order and OrderPayment before any Contract exists.
3. Call `checkout.payOrder` with a caller-supplied idempotency key.
4. Reserve POINT into a reservation-specific ESCROW account.
5. Create one Contract, mark the Order paid, confirm the slot, and persist the
   replayable command result in the same database transaction.
6. Repeating the same command returns the original result without another
   financial or Contract effect.

The PoC covers internal POINT funding only. Provider approval, additional
payments, donations, completion, settlement, refunds, withdrawals, accounting
entries, outbox delivery, and production migration are outside this probe.

## Modules and seams

The modules are `commission-type`, `order`, `financial-ledger`, `contract`,
`slot`, and `checkout`. `checkout` owns the cross-owner orchestration and follows
Crepe's `read → decide → execute` rule: it reads through owner repos, creates a
pure checkout plan in core, and applies that plan through owner repo executors.
`services.ts` creates the checkout service once and exposes it to GraphQL. This
adds the following sanctioned compile-time edges:

```text
services -> checkout
checkout -> commission-type.repo | order.repo | financial-ledger.{core,repo} | contract.repo | slot.repo
financial-ledger -> no product module
```

The dependency-cruiser allowlist and generated module graph encode these edges.
Checkout may reach only the listed owner plan/repo files; owner services,
delivery, and arbitrary implementation files remain forbidden. An import from
`financial-ledger` to Order/Contract/commission-type/slot must fail
`pnpm check:graph`.

The checkout interface has one deep operation:

```ts
checkout.payOrder({ orderPaymentId, actorId, commandKey })
  -> { orderId, orderPaymentId, contractId, reservationId, replayed }
```

Callers need not know the lock order, funding allocations, owner write order,
or rollback mechanics. Checkout opens the transaction and passes that same
handle as the first argument to every owner repo call. Repos never choose a DB
handle or open a nested transaction.

## Persisted model

The schema uses integer POINT amounts and these logical records:

- `CommissionType`: the purchasable offer and worker.
- `CommissionSlot`: an available unit of capacity owned by the worker.
- `Order`: buyer, commission type snapshot, slot, amount, and
  `REQUESTED | PAID` state. Prepayment data belongs here.
- `OrderPayment`: an immutable payment attempt for the Order with
  `PENDING | PAID` state and one optional product-owned financial link.
- `FinancialReservation`: generic amount, currency, holder, purpose, state,
  and immutable `bindingNamespace + bindingKey`. It has no product FK.
- `FinancialAccount`: `AVAILABLE` for a holder or `ESCROW` for one financial
  reservation. The schema constrains purpose-specific ownership.
- `FinancialTransfer` and `FinancialTransferAllocation`: append-only movement
  and the source-lot allocations used by the reservation.
- `PointLot`: paid/free provenance and remaining amount.
- `OrderFinancialLink`: owned on the product side, unique in both
  `orderPaymentId` and `reservationId` directions.
- `Contract`: the formed commission, with unique `orderId`.
- `CheckoutCommand`: unique command key, payload hash, and OrderPayment
  reference. Replay derives reservation and Contract identifiers through the
  product-owned relations, so unrelated result identifiers cannot be stored.

The financial models contain no `orderId`, `contractId`, `commissionTypeId`, or
`slotId`. The financial module validates holder, currency, amount, and remaining
lots for the opaque binding derived by checkout. The Order module owns and
writes `OrderFinancialLink` after the reservation plan is applied.

For the PoC, balance is reconstructed from available lot remainders and the
reservation transfer. A production-ready balance projection and the full
multi-currency Action/Operation hierarchy are deliberately deferred because
they are not needed to answer the module-seam question.

## Transaction and concurrency

`checkout.payOrder` opens one READ COMMITTED `uow.serialized` transaction. Lock
namespaces are appended for `orderPayment`, `financialHolder`,
`commissionSlot`, and the hashed `checkoutCommand` key. The existing global
ordering prevents deadlocks. READ COMMITTED is intentional: a waiter acquires
the command lock and then observes the winner's committed command instead of a
snapshot taken before the wait. The service also compares the buyer, slot, and
holder found after locking with the pre-transaction lock targets and aborts on
any reassignment. Inside the transaction it:

1. claims or replays the checkout command;
2. reads payment, buyer, offer, slot, holder, account, and lot facts through the
   owner repos;
3. builds a pure checkout plan and financial allocation plan;
4. applies the reservation, Contract, paid Order, occupied slot, and command
   result through owner repo executors.

Every owner repo receives the same Prisma transaction handle directly from the
checkout service. All calls are awaited. A thrown owner error aborts the entire
transaction. Database uniqueness
on Contract order, OrderPayment link, reservation binding, and command key backs
the application rules. Deferred transfer checks also require the exact
reservation amount, matching holder/source and reservation/destination
accounts, an exact allocation sum, source-account lot membership, and
`originalAmount = remainingAmount + cumulative allocations` for every lot.
Reservation reference/binding/amount/holder/currency/purpose, account ownership,
and lot origin/account/provenance are immutable from creation. Transfers and
allocations are append-only, so neither concurrent nor later updates can
invalidate or rewrite a committed economic history.

A repeated command key with the same payload returns the stored result with
`replayed: true`. Reuse with a different payload is a domain error. A different
command key for an already-paid OrderPayment returns the existing economic
result rather than creating another reservation or Contract.

## GraphQL surface

The PoC adds a `checkoutCommission` mutation taking `orderPaymentId`, `actorId`,
and `commandKey`. It returns a small payload of opaque integer identifiers and
the replay flag. Test fixtures call owner repo functions directly to prepare the
offer, slot, order, payment, buyer, account, and lot; no broad administrative
GraphQL surface is added for setup.

Expected business failures use `DomainError` subclasses: invalid actor,
unpayable Order, unavailable slot, insufficient POINT, and idempotency payload
mismatch. Unexpected persistence failures remain masked by the existing GraphQL
error handling.

## Verification

The PoC is accepted when the following checks pass:

- A GraphQL checkout moves the requested POINT to one generic ESCROW
  reservation and atomically creates exactly one Contract, paid OrderPayment,
  paid Order, confirmed slot, product-owned financial link, and command result.
- A forced Contract write failure leaves every record and lot in its prepayment
  state.
- Same-key retry returns the stored result with no additional economic effect.
- A different-key retry also produces no duplicate reservation or Contract.
- Command-key reuse with different input fails without writes.
- A barrier pauses the first real PostgreSQL transaction after lock acquisition;
  `pg_locks` then proves the second connection is waiting before release. Those
  tests cover same-payment replay and cross-payment command-key mismatch.
- Insufficient POINT and unavailable slot fail without partial writes.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:graph`, focused module/integration
  tests, the GraphQL schema snapshot, and the full `pnpm test` suite pass.

The implementation will include concise `NOTES.md` findings beside the PoC,
recording whether the service remained deep, how the Plan/Apply split behaved,
and which design decisions should be carried into Crepe.
