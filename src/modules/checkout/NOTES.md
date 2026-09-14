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

## What leaked through the ports

Every owner operation receives the shared `DbClient` transaction handle. This
is a deliberate infrastructure capability: it permits one database commit but
does not expose another owner's Prisma delegate. The checkout port surface has
seven purpose-specific operations across five owners. For this flow that remains
smaller than exposing repositories or entity-shaped CRUD, but it is the first
thing to reassess if later flows cause the port to grow.

The composition adapter accepts a Contract writer override solely to force the
rollback proof. If this design is absorbed, tests can assemble
`createCheckoutService` with explicit ports and the production composition
factory can lose that override.

## Deliberate limitations

- GraphQL accepts `actorId` because this reference has no authenticated
  principal. Production must derive the actor from trusted request context.
- The financial model is the minimum needed for a POINT hold. It does not prove
  the full Currency-specific Action/Operation ledger, settlement, refund,
  withdrawal, accounting, or outbox designs.
- PGlite proves transaction rollback and PostgreSQL constraints but uses one
  connection. It cannot run a true parallel checkout race. Advisory lock order,
  guarded lot updates, and unique constraints encode the concurrency strategy;
  production PostgreSQL still needs the concurrent integration case.
- The pre-transaction read discovers immutable lock identifiers. The complete
  facts are re-read and validated inside the locked REPEATABLE READ transaction.
- `FinancialHolder(user, id)` is an opaque adapter binding with no User FK. A
  production composition root must authenticate that binding; a caller must not
  choose arbitrary namespaces or holder IDs.

## Run the proof

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm prisma:generate
pnpm test src/tests/modules/checkout/checkout.core.test.ts
pnpm test src/tests/modules/checkout/checkout.service.test.ts
pnpm test src/tests/e2e/graphql.test.ts
pnpm check:graph
```

The branch should be absorbed only after the omitted production concerns have
their own design and tests. Otherwise, keep this commit history as the result and
delete the prototype branch after the architectural decision is recorded in the
Crepe repository.
