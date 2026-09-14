# Ledger checkout PoC findings

> **PROTOTYPE — delete or absorb after review.** This branch answers an
> architecture question. It is not a production payment implementation or a
> migration plan for Crepe.

## Question and result

The probe asked whether an initial commission checkout could preserve one small
interface while atomically changing several independently owned models. The
implemented interface is:

```ts
checkout.payOrder({ orderPaymentId, actorId, commandKey })
  -> { orderId, orderPaymentId, contractId, reservationId, replayed }
```

The focused integration and GraphQL tests demonstrate one PGlite transaction
that consumes POINT lot value, creates a generic reservation and ESCROW account,
forms one Contract, marks Order and OrderPayment paid, occupies the slot, writes
the product-owned financial link, and persists a replayable command result.
A forced Contract failure rolls all of those changes back.

The interface stayed deep: callers supply three scalars and do not know owner
write order, lock order, lot allocation, reservation binding, transaction
handling, or replay mechanics. Those details remain behind checkout and its
ports.

## Dependency result

`src/composition/checkout-composition.ts` is the only implementation that
imports all participating owner modules. `checkout` imports only its own core,
port, and repo plus shared DB/foundation modules. `financial-ledger` has no
product imports and its persisted rows have no Order, Contract, commission-type,
or slot foreign key. The product-owned `OrderFinancialLink` points to the generic
financial reservation.

Run `pnpm check:graph` to enforce the import rules and `pnpm graph:modules` to
regenerate both dependency SVGs. The overview includes the composition node so
the intended fan-in is visible rather than hidden in `services.ts`.

## Transaction capability and boundary enforcement

Only `checkout-composition.ts` receives the shared `DbClient` and binds owner
operations to it. Checkout receives no-DB-argument functions, so its port
surface cannot use another owner's Prisma delegate. Dependency-cruiser makes
that composition file the sole importer of the five `*.checkout.ts` owner
adapters and gives it an exact outbound allowlist. Oxlint classifies those
adapters as transaction participants that cannot open transactions, take locks,
or reach services and transport code.

The composition adapter accepts a Contract writer override solely to force the
rollback proof. If this design is absorbed, tests can assemble
`createCheckoutService` with explicit ports and the production composition
factory can lose that override.

## Deliberate limitations

- GraphQL accepts `actorId` because this reference has no authenticated
  principal. Production must derive the actor from trusted request context.
- The financial model is the minimum needed for a POINT hold. The reservation
  carries `purpose = COMMISSION_PAYMENT`, and commit-time checks prove transfer
  amount, accounts, allocation sum, source-lot membership, and original value
  equals the remaining value plus cumulative allocations. It does not prove
  the full Currency-specific Action/Operation ledger, settlement, refund,
  withdrawal, accounting, or outbox designs.
- PGlite proves rollback and constraints. A separate opt-in test uses two real
  PostgreSQL clients and proves concurrent same-payment replay plus cross-payment
  command-key mismatch classification.
- The pre-transaction read discovers immutable lock identifiers. The complete
  facts are re-read after the locks in a READ COMMITTED transaction, and buyer,
  slot, and holder are compared with the locked targets before any owner write.
- `FinancialHolder(user, id)` is an opaque adapter binding with no User FK. A
  production composition root must authenticate that binding; a caller must not
  choose arbitrary namespaces or holder IDs.

## Run the proof

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm prisma:generate
pnpm test src/tests/modules/checkout/checkout.core.test.ts
pnpm test src/tests/modules/checkout/checkout.service.test.ts
pnpm test src/tests/e2e/graphql.test.ts
CHECKOUT_RACE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app \
  pnpm test src/tests/integrations/checkout-concurrency.postgres.test.ts
pnpm check:graph
```

## Independent review record

The initial architecture and integrity reviews both requested changes. The
revision serializes command keys, uses READ COMMITTED after lock waits, derives
replay results through product relations, enforces ledger conservation in the
database, narrows transaction capabilities at composition, and enforces the
adapter allowlist. Final reviewer verdicts are recorded in the PR description.

The branch should be absorbed only after the omitted production concerns have
their own design and tests. Otherwise, keep this commit history as the result and
delete the prototype branch after the architectural decision is recorded in the
Crepe repository.
