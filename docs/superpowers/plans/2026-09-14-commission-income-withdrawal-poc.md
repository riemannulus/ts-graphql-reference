# Commission Income Settlement and Withdrawal PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove amount-level lineage from commission POINT settlement through withdrawable INCOME to a multi-commission withdrawal hold.

**Architecture:** Keep flow/command/operation identity in `transaction-flow`, generalized account/lot/action storage in `financial-ledger`, and compose them from new `commission-settlement` and `income-withdrawal` modules. Each use-case reads facts, produces a pure plan, and mechanically applies it in one serialized transaction.

**Tech Stack:** TypeScript, Prisma 7, PostgreSQL/PGlite, Vitest, Pothos GraphQL, dependency-cruiser

**Spec:** `docs/superpowers/specs/2026-09-14-commission-income-withdrawal-poc-design.md`

## Global Constraints

- `INCOME` is a distinct internal Currency with a PoC quote of exactly `1 POINT = 1 INCOME`.
- Commission SETTLE stays on its `COMMISSION` flow; withdrawal owns a new `WITHDRAWAL` flow.
- Every INCOME amount remains traceable through immutable lot source fields and transfer allocations.
- Composite services use direct reviewed owner repo imports and one transaction handle, following `CONVENTIONS.md`.
- Financial history is append-only; retries return the existing economic result.
- The migration is fresh-database only under the user's explicit external-PoC exception.

---

### Task 1: Generalize ledger storage and constraints

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/20260914200000_typed_financial_flow_ids/migration.sql`
- Modify: `prisma/migrations/20260914201000_financial_history_immutability/migration.sql`
- Test: `src/tests/integrations/schema-constraints.test.ts`

**Interfaces:**
- Produces: generic `FinancialLot`, Currency-explicit transfers/allocations, `FinancialSwapAction`, and `FinancialSwapLeg`.

- [x] Add failing schema-constraint tests for cross-Currency transfers, wrong-account lot allocations, malformed SWAPs, mutable INCOME lineage, and non-SETTLE INCOME sources.
- [x] Run the focused constraint suite and confirm each new assertion fails because the models or constraints are absent.
- [x] Replace `PointLot` with `FinancialLot`, add composite Currency keys, and add SWAP models to Prisma.
- [x] Regenerate the fresh-only migration SQL, then restore the reviewed handwritten append-only and deferred SWAP constraints.
- [x] Generate Prisma and run the focused constraints until green.

### Task 2: Separate generic operation creation from action storage

**Files:**
- Modify: `src/modules/transaction-flow/transaction-flow.repo.ts`
- Modify: `src/modules/financial-ledger/financial-ledger.repo.ts`
- Modify: `src/modules/commission-checkout/commission-checkout.service.ts`
- Test: `src/tests/modules/commission-checkout/commission-checkout.service.test.ts`

**Interfaces:**
- Produces: `createOperation`, `completeCommand`, and financial-ledger action writers.
- Consumes: `FinancialOperation` and action models from Task 1.

- [x] Add a failing checkout test that observes generic operation creation followed by the ledger-owned TRANSFER action.
- [x] Run it and confirm failure against the coupled `createTransferOperation` path.
- [x] Move TRANSFER action creation to `financial-ledger.repo.ts`; leave flow identity writes generic.
- [x] Run checkout unit/integration tests and confirm replay behavior remains green.

### Task 3: Settle a commission into INCOME

**Files:**
- Create: `src/modules/commission-settlement/commission-settlement.core.ts`
- Create: `src/modules/commission-settlement/commission-settlement.service.ts`
- Create: `src/modules/commission-settlement/schemas/index.ts`
- Create: `src/modules/commission-settlement/schemas/commission-settlement.mutation.ts`
- Modify: `src/modules/contract/contract.repo.ts`
- Modify: `src/modules/financial-ledger/financial-ledger.repo.ts`
- Modify: `src/services.ts`
- Modify: `src/graphql/schema.ts`
- Test: `src/tests/modules/commission-settlement/commission-settlement.core.test.ts`
- Test: `src/tests/modules/commission-settlement/commission-settlement.service.test.ts`

**Interfaces:**
- Produces: `planCommissionSettlement(facts, input)` and `createCommissionSettlementService(db).settle(input)`.
- Consumes: worker/commission/reservation facts, generic operation creation, SWAP and FinancialLot writers.

- [x] Write failing core tests for worker authorization, paid/held state, POINT input, fixed quote, and the complete SETTLE plan.
- [x] Run the core tests and confirm missing behavior failures.
- [x] Implement the pure settlement plan.
- [x] Write failing service tests for first settlement, replay, alias replay, and immutable commission source lineage.
- [x] Implement read → plan → apply under ordered locks, including both SWAP legs and the INCOME lot.
- [x] Register and snapshot the GraphQL mutation; run the module tests until green.

### Task 4: Reserve a multi-commission INCOME withdrawal

**Files:**
- Create: `src/modules/income-withdrawal/income-withdrawal.core.ts`
- Create: `src/modules/income-withdrawal/income-withdrawal.repo.ts`
- Create: `src/modules/income-withdrawal/income-withdrawal.service.ts`
- Create: `src/modules/income-withdrawal/schemas/index.ts`
- Create: `src/modules/income-withdrawal/schemas/income-withdrawal.mutation.ts`
- Modify: `src/modules/financial-ledger/financial-ledger.repo.ts`
- Modify: `src/modules/transaction-flow/transaction-flow.repo.ts`
- Modify: `src/services.ts`
- Modify: `src/graphql/schema.ts`
- Test: `src/tests/modules/income-withdrawal/income-withdrawal.core.test.ts`
- Test: `src/tests/modules/income-withdrawal/income-withdrawal.service.test.ts`

**Interfaces:**
- Produces: `planIncomeWithdrawal`, an idempotent withdrawal service, and an audit projection from withdrawal allocations to source commission flows.
- Consumes: generic lot FIFO allocation, WITHDRAWAL flow creation, and TRANSFER action writers.

- [x] Write failing core tests for positive amount, FIFO selection, and insufficient INCOME.
- [x] Implement the pure withdrawal plan and make the focused tests green.
- [x] Write failing service tests that settle two commissions, withdraw across both lots, replay safely, and query exact source-flow amounts.
- [x] Implement atomic WITHDRAWAL flow/policy/request/operation/reservation/transfer creation and guarded lot decrements.
- [x] Register the GraphQL mutation and audit fields; run the focused tests until green.

### Task 5: PostgreSQL races, module graph, and documentation

**Files:**
- Modify: `src/tests/integrations/commission-checkout-concurrency.postgres.test.ts`
- Modify: `.dependency-cruiser.mjs`
- Modify: `src/modules/README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/adr/0001-typed-financial-flow-identifiers.md`
- Modify: `src/modules/dependency-graph.svg`
- Modify: `src/modules/dependency-graph-detail.svg`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh-PostgreSQL evidence, an explicit DAG, and durable terminology.

- [x] Add a PostgreSQL-only test for malformed deferred SWAP rejection and concurrent withdrawal of the same INCOME.
- [x] Run it against a fresh PostgreSQL database and confirm the missing protections fail first.
- [x] Complete migration triggers/locks until exactly one concurrent withdrawal succeeds and malformed SWAPs fail.
- [x] Add only the two composite-to-owner edges, regenerate module graphs, and document the rationale.
- [x] Update the glossary and ADR with settlement/withdrawal lineage and payout-batch extension.
- [x] Run Prisma validation/drift, typecheck, lint, graph check, build, full tests, and `git diff --check`.
- [x] Obtain independent architecture and data-integrity approval, respond to every critique, and record the final verdicts in the PR.
- [ ] Commit, push, update PR #17, update the hosted explanation site, and confirm GitHub CI.
