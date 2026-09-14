# Commission checkout ledger PoC findings

> **PROTOTYPE — delete or absorb after review.** This branch answers an
> architecture question. It is not a production payment implementation or a
> migration plan for Crepe.

## Question and result

The probe asked whether an initial commission checkout could preserve one small
interface while atomically changing several independently owned models. The
implemented interface is:

```ts
commissionCheckout.complete({ orderPaymentId, actorId, commandKey })
  -> { orderId, orderPaymentId, contractId, reservationId, replayed }
```

The focused integration and GraphQL tests demonstrate one PGlite transaction
that consumes POINT lot value, creates a generic reservation and ESCROW account,
forms one Contract, marks Order and OrderPayment paid, occupies the slot, writes
the product-owned financial link, and persists a replayable command result.
A forced Contract failure rolls all of those changes back.

The interface stayed deep: callers supply three scalars and do not know owner
write order, lock order, lot allocation, reservation binding, transaction
handling, or replay mechanics. Those details remain behind commission checkout's
read → plan → apply service.

## Dependency result

`commission-checkout.service.ts` directly imports the participating owner repos and passes
the same transaction handle as their first argument. Its cross-module edge is
narrowed by dependency-cruiser to the five reviewed repos plus
`financial-ledger.core` planning. `financial-ledger` has no product imports and
its persisted rows have no Order, Contract, commission-type, or slot foreign
key. The product-owned `OrderFinancialLink` points to the generic financial
reservation.

Run `pnpm check:graph` to enforce the import rules and `pnpm graph:modules` to
regenerate both dependency SVGs. The overview shows the one-way
commission-checkout → owner
edges explicitly.

## Transaction capability and boundary enforcement

Commission checkout opens the transaction and hands its `$tx` directly to owner repo reads
and `apply*` executors. `commission-checkout.core.planCommissionCheckout` describes the reservation,
Contract, paid Order, and occupied slot as pure data; the service adds the
financial lot-allocation plan and the repos execute those plans mechanically.
Owner repos never open a transaction or choose a database handle. The rollback
test rejects the real Contract insert with a temporary database trigger, so the
proof needs no injected writer or module mock.

## Deliberate limitations

- GraphQL accepts `actorId` because this reference has no authenticated
  principal. Production must derive the actor from trusted request context.
- The financial model is the minimum needed for a POINT hold. The reservation
  carries `purpose = COMMISSION_PAYMENT`, and commit-time checks prove transfer
  amount, accounts, allocation sum, source-lot membership, and original value
  equals the remaining value plus cumulative allocations. The referenced
  reservation, account, and lot basis columns are immutable from creation;
  transfers and allocations are append-only. Concurrent or later updates cannot
  invalidate or rewrite a committed transfer. It does not prove
  the full Currency-specific Action/Operation ledger, settlement, refund,
  withdrawal, accounting, or outbox designs.
- PGlite proves rollback and constraints. A separate opt-in test uses two real
  PostgreSQL clients and proves concurrent same-payment replay plus cross-payment
  command-key mismatch classification.
- The pre-transaction read discovers immutable lock identifiers. The complete
  facts are re-read after the locks in a READ COMMITTED transaction, and buyer,
  slot, and holder are compared with the locked targets before any owner write.
- `FinancialHolder(user, id)` is an opaque binding with no User FK. Production
  must authenticate the actor and derive this binding from Order ownership; a
  caller must not choose arbitrary namespaces or holder IDs.

## Run the proof

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm prisma:generate
pnpm test src/tests/modules/commission-checkout/commission-checkout.core.test.ts
pnpm test src/tests/modules/commission-checkout/commission-checkout.service.test.ts
pnpm test src/tests/e2e/graphql.test.ts
COMMISSION_CHECKOUT_RACE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app \
  pnpm test src/tests/integrations/commission-checkout-concurrency.postgres.test.ts
pnpm check:graph
```

## Independent review record

The initial architecture and integrity reviews both requested changes. The
revision serializes command keys, uses READ COMMITTED after lock waits, derives
replay results through product relations, enforces ledger conservation in the
database, and narrows commission-checkout's direct imports to owner plan/repo APIs. Final
reviewer verdicts are recorded in the PR description.

The branch should be absorbed only after the omitted production concerns have
their own design and tests. Otherwise, keep this commit history as the result and
delete the prototype branch after the architectural decision is recorded in the
Crepe repository.
