# Commission Checkout Ledger PoC Design

## Question

Can an initial commission payment create the Contract and reserve POINT atomically while also exposing the planned Flow → Command → Operation → Action identity, without making the payment module import product implementations?

This is a throwaway proof of concept. It is not a production migration.

## Implemented vertical slice

A commission Order is created before payment and owns one typed `TransactionFlow(kind = COMMISSION)`. `commissionCheckout.complete({ orderPaymentId, actorId, commandKey })` then performs one serialized transaction:

1. load and lock the OrderPayment, buyer holder, commission slot, and principal-scoped PAY idempotency key;
2. validate Order, payment, commission type, slot, actor, amount, and currency in the pure plan;
3. create a typed PAY Command Run and matching PAY Operation with a `FinancialTransferAction`;
4. move the selected POINT lots from AVAILABLE to a reservation-specific ESCROW account;
5. form the Contract, mark Order and OrderPayment paid, occupy the slot, and create the product-owned financial link;
6. return the full public identity with the product result.

```ts
commissionCheckout.complete({ orderPaymentId, actorId, commandKey })
  -> {
       orderId, orderPaymentId, contractId, reservationId,
       referenceId: "COMMISSION-<flow UUID>",
       commandId: "CMD-PAY-<command UUID>",
       operationId: "OP-PAY-<operation UUID>",
       replayed
     }
```

Provider approval, additional payments, completion, settlement, refund, withdrawal, accounting entries, and outbox delivery remain outside the executable slice.

## Module boundaries

`commission-checkout` is the cross-owner orchestration module. It directly imports the owner repos for `commission-type`, `order`, `contract`, `slot`, `financial-ledger`, plus the generic `transaction-flow` core/repo. Each repo accepts the same transaction handle. There are no injected repo ports.

`transaction-flow` imports no product module. It receives a principal, idempotency key, opaque subject binding, and flow id. `financial-ledger` imports no Order, Contract, commission type, or slot module. Product-to-finance navigation remains owned by `OrderFinancialLink`.

```text
services -> commission-checkout
commission-checkout -> commission-type.repo
                    -> order.repo
                    -> contract.repo
                    -> slot.repo
                    -> financial-ledger.{core,repo}
                    -> transaction-flow.{core,repo}
transaction-flow -> db only
financial-ledger -> db + its core only
```

Dependency-cruiser enforces those edges.

## Persisted identity and invariants

Opaque UUIDs provide uniqueness. Stored enum kinds provide meaning. Public IDs are derived, so a writable string prefix cannot disagree with the row:

- `TransactionFlow(id, kind)` is the commission lifecycle identity. `Order.flowId` owns it; reservations and commands reuse it.
- `FinancialCommandRun(id, flowId, flowKind, kind, principalId, idempotencyKey, subject)` records a request. `(principalId, kind, idempotencyKey)` is unique.
- `FinancialOperation(id, flowId, kind, originatingCommandId)` records the committed result.
- `FinancialTransferAction(id, flowId, operationId)` is the structural TRANSFER subtype; `FinancialTransfer.actionId` cannot reference another action family.

A composite FK from Command Run `(flowId, flowKind)` to Flow `(id, kind)` rejects a copied flow kind that does not match the flow. A second composite FK from Operation `(originatingCommandId, flowId, kind)` to Command Run `(id, flowId, kind)` rejects an operation with a different flow or command kind. Composite FKs also keep OrderPayment, Contract, OrderFinancialLink, FinancialReservation, FinancialTransfer, and FinancialTransferAction on one flow.

PostgreSQL triggers make Command identity/payload/subject append-only and permit `resultOperationId` to move from NULL to its own originated Operation once. A result-alias Command cannot originate another Operation. Every Operation or TransferAction UPDATE/DELETE is rejected, and Order and reservation flow bindings are immutable as well.

The PoC schema contains only the `COMMISSION` flow family and its command vocabulary: `PAY`, `EXTRA_PAY`, `SETTLE`, `REFUND`, `CANCEL`. Each flow creator writes its own `FlowCommandPolicy` rows. `FinancialCommandRun(flowId, kind)` must match that allow-list, so a new flow family starts with no legal commands until its creator explicitly chooses them.

The generated migration targets a fresh database because this branch has not shipped. It does not preserve rows from the preceding PoC migration. Legacy physical `referenceId` columns remain nullable, new writes leave them NULL, and public APIs never read them. Production adoption needs a separate backfill and cutover migration.

## Retry behavior

Repeating the same principal, PAY kind, and idempotency key validates the payload hash and returns the same Command and Operation. A new key for an already paid OrderPayment creates a new Command Run that points to the existing Operation. It therefore returns a new `CMD-PAY-…` while keeping the same `COMMISSION-…` and `OP-PAY-…`, reservation, and Contract.

Command locks use `principalId:PAY:idempotencyKey`, matching the database uniqueness scope. OrderPayment, holder, and slot locks prevent duplicate economic effects and stale ownership writes. READ COMMITTED lets a waiter observe the winner after acquiring the advisory lock.

## Verification

The proof requires:

- formatter tests for all three public ID shapes;
- GraphQL and service tests that expose and replay the full identity;
- a different-key replay test proving only Command ID changes;
- DB tests rejecting a non-commission command value and an Operation kind that differs from its originating Command;
- rollback tests leaving no Command, Operation, Action, reservation, transfer, Contract, or product transition after failure;
- real PostgreSQL concurrency tests for same-payment replay, same-principal key collision with a different payload, and immutable reservation behavior;
- generated migration application with zero Prisma schema drift;
- `pnpm typecheck`, `pnpm lint`, `pnpm check:graph`, `pnpm build`, and the full test suite.

See `CONTEXT.md` and ADR 0001 for the domain vocabulary and extension rule.
