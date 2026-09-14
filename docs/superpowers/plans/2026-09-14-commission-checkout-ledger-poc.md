# Commission Checkout Ledger PoC Implementation Plan

> Revision note (2026-09-14): the original execution checklist below records the first slice. The accepted follow-up replaces arbitrary `referenceId`/`CommissionCheckoutCommand` identity with the typed Flow → Command → Operation → Action model in the companion design spec, `CONTEXT.md`, and ADR 0001. Those documents are authoritative where identifiers or persisted models differ.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that one GraphQL commission checkout can atomically reserve POINT and form a Contract by applying a pure plan through isolated owner repos.

**Architecture:** `commission-checkout` owns one deep `complete` interface. Its service reads owner repos, builds a pure `CommissionCheckoutPlan`, and passes one transaction directly to owner `apply*` repo functions. `services.ts` wires the service once. Prisma/PGlite proves persistence, uniqueness, rollback, and replay, a real PostgreSQL test proves lock-wait behavior, and dependency-cruiser proves the exact repo/core import allowlist.

**Tech Stack:** TypeScript 6 ESM, Pothos GraphQL, Prisma 7/PostgreSQL, PGlite, Vitest, dependency-cruiser, Graphviz, pnpm 10.33.0.

**Spec:** `docs/superpowers/specs/2026-09-14-commission-checkout-ledger-poc-design.md`

## Global Constraints

- The PoC covers initial internal POINT commission checkout only and remains explicitly marked throwaway.
- `commission-checkout` imports only reviewed owner repo/core files; `financial-ledger` imports no product module.
- Financial tables contain no Order, Contract, commission-type, or slot foreign key.
- All internal effects and the replayable command result commit in one `uow.serialized` transaction.
- Existing untracked files in the primary checkout are out of scope and remain untouched.

---

### Task 1: Persist the model and database invariants

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260914090000_ledger_checkout_poc/migration.sql`
- Modify: `src/tests/integrations/schema-constraints.test.ts`

**Interfaces:**
- Consumes: existing `makeTestPrisma()` migration runner.
- Produces: Prisma delegates for `CommissionType`, `CommissionSlot`, `Order`, `OrderPayment`, `FinancialHolder`, `FinancialAccount`, `FinancialReservation`, `PointLot`, `FinancialTransfer`, `FinancialTransferAllocation`, `OrderFinancialLink`, `Contract`, and `CommissionCheckoutCommand`.

- [ ] **Step 1: Write the failing schema test**

Add raw-SQL tests which assert that a financial reservation cannot reuse
`(bindingNamespace, bindingKey)`, an Order cannot have two Contracts, and a
financial account cannot be both holder-owned and reservation-owned:

```ts
await expect(insertDuplicateReservationBinding(prisma)).rejects.toThrow(
  /FinancialReservation_bindingNamespace_bindingKey_key/,
);
await expect(insertSecondContract(prisma)).rejects.toThrow(/Contract_orderId_key/);
await expect(insertAmbiguousFinancialAccount(prisma)).rejects.toThrow(
  /FinancialAccount_owner_check/,
);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm test src/tests/integrations/schema-constraints.test.ts`

Expected: FAIL because the PoC tables do not exist.

- [ ] **Step 3: Add Prisma models and migration DDL**

Use string states backed by named CHECK constraints. Put the product-side FK on
`OrderFinancialLink.reservationId`; leave every financial row free of product
IDs. Add uniqueness for command key, Contract order, slot assignment, payment
link, reservation reference, and reservation binding. All amounts are positive
or non-negative as appropriate.

```prisma
model FinancialReservation {
  id               Int    @id @default(autoincrement())
  referenceId      String @unique
  bindingNamespace String
  bindingKey       String
  holderId         Int
  currency         String
  targetAmount     Int
  state            String @default("HELD")
  @@unique([bindingNamespace, bindingKey])
}

model OrderFinancialLink {
  orderPaymentId Int @id
  reservationId  Int @unique
}

model Contract {
  id      Int @id @default(autoincrement())
  orderId Int @unique
}
```

- [ ] **Step 4: Regenerate and verify GREEN**

Run:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm prisma:generate
pnpm test src/tests/integrations/schema-constraints.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma src/tests/integrations/schema-constraints.test.ts
git commit -m "🧪 결제 원장 PoC 모델과 제약 추가"
```

### Task 2: Implement owner repos and the commission-checkout plan

**Files:**
- Create: `src/modules/commission-type/commission-type.repo.ts`
- Create: `src/modules/order/order.core.ts`
- Create: `src/modules/order/order.repo.ts`
- Create: `src/modules/financial-ledger/financial-ledger.core.ts`
- Create: `src/modules/financial-ledger/financial-ledger.repo.ts`
- Create: `src/modules/contract/contract.repo.ts`
- Create: `src/modules/slot/slot.repo.ts`
- Create: `src/modules/commission-checkout/commission-checkout.core.ts`
- Test: `src/tests/modules/commission-checkout/commission-checkout.core.test.ts`

**Interfaces:**
- Consumes: generated Prisma types and `DbClient`.
- Produces: `CommissionCheckoutPlan`, `CommissionCheckoutResult`, `planCommissionCheckout()`, and owner repo `apply*` executors.

- [ ] **Step 1: Write failing pure-core tests**

Test literal outcomes for actor mismatch, non-pending payment, amount mismatch,
and verified formation DTO construction. Each test names the production branch
whose removal it catches.

```ts
expect(() => planCommissionCheckout(facts, { actorId: 2 })).toThrow(CommissionCheckoutActorError);
expect(planCommissionCheckout(facts, { actorId: 1 })).toEqual({
  financialRequest: { referenceId: 'order-payment:20', currency: 'POINT', amount: 500 },
  contract: { orderId: 10, buyerId: 1, workerId: 2 },
  paidOrder: { orderId: 10, orderPaymentId: 20 },
  occupiedSlot: { slotId: 30, workerId: 2 },
});
```

- [ ] **Step 2: Run the core test and verify RED**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.core.test.ts`

Expected: FAIL because the commission-checkout core and types do not exist.

- [ ] **Step 3: Implement minimal pure DTO validation**

`commission-checkout.core.ts` accepts plain facts and returns a frozen-by-convention plan;
it imports only `foundation/errors.ts`. Owner repo functions read state or apply
the plan mechanically on the caller's transaction.

- [ ] **Step 4: Run the core test and verify GREEN**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.core.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules src/tests/modules/commission-checkout
git commit -m "✨ commission checkout 계획과 도메인별 repo 실행기 추가"
```

### Task 3: Compose and atomically execute commission checkout

**Files:**
- Create: `src/modules/commission-checkout/commission-checkout.service.ts`
- Modify: `src/db/lock-registry.ts`
- Modify: `src/services.ts`
- Test: `src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

**Interfaces:**
- Consumes: `Db`, `uow.serialized`, `CommissionCheckoutPlan`, and the owner repos from Task 2.
- Produces: `createCommissionCheckoutService(db).complete(input)`. Order and finance repos locate lock targets on `db.rw`; the same facts are re-read and validated inside the transaction.

- [ ] **Step 1: Write the failing atomic-flow test**

Use real PGlite and real owner repos. Seed the world through Prisma, call the
wished-for commission-checkout interface, and assert literal row counts and states. Add a
second test with a temporary DB trigger that rejects the real Contract insert; assert
zero reservations/transfers/contracts/links/commands and unchanged lot, Order,
payment, and slot.

```ts
const result = await commissionCheckout.complete({ orderPaymentId, actorId: buyer.id, commandKey: 'pay-1' });
expect(result).toMatchObject({ orderId, orderPaymentId, replayed: false });
expect(await prisma.contract.count()).toBe(1);
expect(await prisma.financialReservation.count()).toBe(1);
expect(await prisma.pointLot.findUniqueOrThrow({ where: { id: lotId } })).toMatchObject({
  remainingAmount: 500,
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

Expected: FAIL because `createCommissionCheckoutService` does not exist.

- [ ] **Step 3: Implement the single transaction**

Load only immutable lock identifiers from the primary, acquire the payment,
holder, slot, and hashed command-key locks, then claim/replay the command,
re-load and validate all facts via owner repos, reserve funds,
build formation, create Contract, link/mark Order paid, confirm slot, then store
the full command result. Use lock keys in global registry order:

```ts
return uow.serialized(
  db,
  [
    lockKey.orderPayment(input.orderPaymentId),
    lockKey.financialHolder(targets.financialHolderId),
    lockKey.commissionSlot(targets.slotId),
    lockKey.commissionCheckoutCommand(input.commandKey),
  ],
  async (tx) => { /* the service passes tx to every owner repo */ },
);
```

The locked transaction remains READ COMMITTED so a waiter sees the command row
committed by the lock holder. Taking a REPEATABLE READ snapshot before a blocking
advisory lock would make that replay result stale. Re-read buyer, slot, and
holder targets inside the transaction and abort if they differ from the values
used to construct the lock keys.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/lock-registry.ts src/modules src/services.ts src/tests/modules/commission-checkout
git commit -m "✨ 최초 결제를 단일 트랜잭션으로 조립"
```

### Task 4: Add replay, duplicate, and failure cases

**Files:**
- Modify: `src/modules/commission-checkout/commission-checkout.service.ts`
- Modify: owner repo files from Task 2 as tests require
- Modify: `src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

**Interfaces:**
- Consumes and preserves: `CommissionCheckoutService.complete`.
- Produces: same-key replay, payload mismatch rejection, different-key economic replay, insufficient-point rejection, and unavailable-slot rejection.

- [ ] **Step 1: Add one failing test per behavior**

Assert complete database effects, not mock calls:

```ts
expect((await commissionCheckout.complete(input)).replayed).toBe(false);
expect((await commissionCheckout.complete(input)).replayed).toBe(true);
await expect(commissionCheckout.complete({ ...otherPayload, commandKey: input.commandKey }))
  .rejects.toBeInstanceOf(CommissionCheckoutIdempotencyError);
expect(await prisma.financialReservation.count()).toBe(1);
expect(await prisma.contract.count()).toBe(1);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

Expected: the newly added branch tests fail for missing behavior.

- [ ] **Step 3: Implement minimal idempotency and rejection branches**

Persist a deterministic payload hash made from `orderPaymentId` and `actorId`;
`commandKey` identifies the command row and is not part of its payload. On a
new key for an already-paid OrderPayment, derive its Contract/reservation result
through the OrderPayment relations and save only the command-to-payment
reference without new economic rows.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules src/tests/modules/commission-checkout
git commit -m "✅ commission checkout 재시도와 실패 원자성 검증"
```

### Task 5: Expose GraphQL and enforce the dependency graph

**Files:**
- Create: `src/modules/commission-checkout/schemas/commission-checkout.mutation.ts`
- Create: `src/modules/commission-checkout/schemas/index.ts`
- Modify: `src/graphql/schema.ts`
- Modify: `src/tests/e2e/graphql.test.ts`
- Modify: `src/tests/e2e/__snapshots__/schema-snapshot.test.ts.snap`
- Modify: `.dependency-cruiser.mjs`
- Modify: `src/modules/README.md`
- Regenerate: `src/modules/dependency-graph.svg`
- Regenerate: `src/modules/dependency-graph-detail.svg`

**Interfaces:**
- Consumes: `ctx.services.commissionCheckout.complete(input)`.
- Produces: `checkoutCommission(input: CommissionCheckoutInput!): CommissionCheckoutResult!`.

- [ ] **Step 1: Write the failing GraphQL test**

Seed real persisted fixtures and assert the transport-visible result:

```graphql
mutation {
  checkoutCommission(input: { orderPaymentId: 1, actorId: 1, commandKey: "gql-pay-1" }) {
    orderId
    orderPaymentId
    contractId
    reservationId
    replayed
  }
}
```

Also assert that replay returns identical identifiers with `replayed: true`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm test src/tests/e2e/graphql.test.ts`

Expected: GraphQL validation fails because `checkoutCommission` is absent.

- [ ] **Step 3: Register the mutation and graph rules**

Use a Pothos `objectRef` payload. Add commission-checkout module registration to
`graphql/schema.ts`. Allow composition imports at the top while keeping module
cross-imports denied, document the new graph, and regenerate both SVGs with
`pnpm graph:modules`.

- [ ] **Step 4: Verify GREEN and update schema snapshot intentionally**

Run:

```bash
pnpm test src/tests/e2e/graphql.test.ts
pnpm test src/tests/e2e/schema-snapshot.test.ts -u
pnpm check:graph
```

Expected: PASS and the snapshot contains only the new input, payload, and
mutation field.

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.mjs src/graphql src/modules src/tests/e2e
git commit -m "✨ commission checkout GraphQL과 의존성 그래프 추가"
```

### Task 6: Capture findings and complete verification

**Files:**
- Create: `src/modules/commission-checkout/NOTES.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all implemented code and verification evidence.
- Produces: one-command usage and durable PoC conclusions.

- [ ] **Step 1: Document the probe result**

Record the question, run commands, confirmed properties, complexity that leaked
through direct owner repo Plan/Apply calls, deliberate omissions, and absorb/delete decision. Mark every PoC
file as experimental in NOTES and link it from the repository README.

- [ ] **Step 2: Run all required verification**

Run, in order:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm prisma:generate
pnpm typecheck
pnpm lint
pnpm check:graph
pnpm build
pnpm test
git diff --check
```

Expected: every command exits 0; Vitest reports zero failed tests.

- [ ] **Step 3: Re-read repository instructions and inspect the final diff**

Confirm no applicable `AGENTS.md` became false, the financial module has no
product imports/FKs, commission-checkout imports only its reviewed owner repo/core files, and the plan/spec have no
unresolved placeholders.

- [ ] **Step 4: Commit**

```bash
git add README.md src/modules/commission-checkout/NOTES.md docs/superpowers/plans/2026-09-14-commission-checkout-ledger-poc.md
git commit -m "📝 commission checkout PoC 결과와 실행 방법 기록"
```

- [ ] **Step 5: Independent review and PR**

Dispatch independent architecture and integrity reviewers over
`main..codex/ledger-checkout-poc`, resolve every finding, re-run the full checks,
record final approvals in the PR body, push the branch, and open a PR against
`main`.
