# Coding Conventions

How this codebase is organized so that **invariants are first-class**, the
code is **property-based-testing (PBT) friendly**, and the GraphQL schema, the
database, and the domain logic stay **cleanly separated**.

## 1. Layers: decide in the core, execute in the shell

Every module splits into explicit layers with one-way dependencies:

| Layer            | Files                                | Speaks                          | May import                                   | Tested with                |
| ---------------- | ------------------------------------ | ------------------------------- | -------------------------------------------- | -------------------------- |
| Core (pure)      | `*.core.ts`, `*.state.ts`, `*.value.ts`, `*.content.ts` | domain types, plans | types + other pure modules, `errors.ts`      | unit + **property** tests  |
| Repo (DB)        | `*.repo.ts`                          | Prisma rows, the Pothos `query` | core types, `@prisma/client`, `db.ts` (`DbClient` / `ReadDbClient`), `prisma-errors.ts`, `errors.ts` | integration (PGlite)       |
| Service (use-cases) | `*.service.ts`                    | domain inputs/outputs only      | core, repo, `uow.ts` / `locks.ts`, `db.ts` (the `Db` handle), `@prisma/client` (row types), `errors.ts` | integration + **model** PBT |
| Delivery (edge)  | `schemas/*` or `*.schema.ts` (GraphQL); `routes/*.route.ts` (HTTP) | GraphQL types + `ctx`, or Fastify req/reply | builder, core (enums/parsers), repo (reads; in a tier-1 module also writes), services (via `ctx` or registration) | e2e (`app.inject`) |

```
schema ──→ service ──→ repo ──→ prisma
   │           │          │
   └───────────┴──────────┴──→ core          core → (nothing)
   └─(reads; tier-1 writes)─→ repo
```

**Enforced by oxlint** (`.oxlintrc.json` `no-restricted-imports` per layer), so
these are not just guidelines: the core cannot import Prisma/GraphQL/repos,
services and repos cannot import the builder or Pothos, schema files cannot
import the db handles, the core/repo/schema layers cannot import `uow`/`locks`
(only a service opens a transaction or takes a lock), `builder.ts` cannot import
feature modules, and `import/no-cycle` keeps the graph acyclic. Two rules the
linter cannot see, reviewed by hand:

- **A business `if` in a service or repo is a leaked decision** — move it to
  the core. The only branching allowed in the execute phase is the mechanical
  mapping of plan fields (`a.depleted ? 'CONSUMED' : undefined`).
- **`await` never appears in a core file.**

### The plan pattern

A use-case is the assembly `read → decide → execute`:

1. The repo reads a **world snapshot** — everything the decision needs, mapped
   to the core's input types. A multi-read snapshot must actually BE one
   snapshot: run the transaction at `REPEATABLE READ` (see
   `point.service.spend`), or a commit landing between the reads shows the
   decision an impossible world.
2. The core decides and returns a **plan**: pure data describing every write,
   including the values each write must still observe
   (`allocation.assumed`, `plan.assumedBalance`).
3. The repo executes the plan mechanically, using those assumptions as
   optimistic-concurrency guards (`updateMany({ where: { ...assumed } })`).
   A missed guard throws `ConcurrentUpdateError` (`CONFLICT`, retryable) and
   rolls back the transaction; a serialization failure from the isolation
   level (`P2034`) is mapped to the same error in the service.

See `point.core.ts` (`planSpend`) / `point.repo.ts` (`applySpendPlan`) /
`point.service.ts` (`spend`) for the blueprint, and `user.state.ts`
(`planTransition`) / `user.repo.ts` (the CAS `transitionStatus`) /
`user.service.ts` (`changeStatus`) for the single-row degenerate case.

### The concurrency ladder

Transactions open through **one module, `uow.ts`** (unit of work) — never
`db.rw.$transaction` directly — so isolation, lock acquisition, and error
translation live in one place, and every use-case fails a race the same way.
Pick the **weakest rung** that preserves the invariant; each higher rung costs
more and hides less:

| Level | Tool                                                     | Lives in         | Reach for it when                                   |
| ----- | -------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| 0     | Atomic statement / guarded CAS (`updateMany where {…assumed}`) | repo       | one write preserves the invariant                   |
| 1     | Unique constraint + `P2002` → `DomainError`              | migration + repo | idempotency / no duplicates                         |
| 2     | Optimistic guard: the plan carries its `assumed` values  | core + repo      | check-then-write, low contention                    |
| 3     | Snapshot isolation (`uow.snapshot`, REPEATABLE READ)     | service          | a decision reads several rows that must agree        |
| 4     | Row lock / queue claim (`FOR UPDATE`, `SKIP LOCKED`)     | repo             | claim specific rows (e.g. a worker queue)           |
| 5     | Advisory lock (`uow.serialized`)                         | service          | serialize across rows a CAS/snapshot can't express  |

`uow` exposes exactly four entry points: `run` (level 0–1, a plain atomic
transaction), `snapshot` (level 3), and `serialized` / `trySerialized` (level
5). All run on `db.rw`, and all translate a serialization failure (`P2034`) into
the same retryable `ConcurrentUpdateError` (`CONFLICT`) the optimistic guards
raise. That **single failure contract** is what lets you move a key down a rung
later — swap `uow.serialized(db, keys, fn)` for `uow.snapshot(db, fn)` — without
touching a single caller.

`uow.snapshot` sets REPEATABLE READ with a `SET TRANSACTION` statement rather
than Prisma's `isolationLevel` option: the production adapter honors the option
but the PGlite test adapter silently drops it, so the SQL form is the only one
that behaves — and is testable — identically in both (see `uow.ts`).

**Advisory locks are the escape hatch, not the default.** The point module
spends and charges with optimistic guards (levels 0–3) and never locks;
`point.transfer` is the one `uow.serialized` example, and even it keeps the
guards. Three rules keep locking safe:

- **Keys come from one registry (`locks.ts`), acquired in one global order.**
  Two transactions locking an overlapping set cannot deadlock because every
  caller sorts the keys the same way (`orderLocks` — pure, property-tested).
  Append a new namespace at the END; never reorder.
- **A lock only serializes writers that take the SAME key.** Mixing a locked
  writer with a lock-free one that touches the same rows protects nothing — so a
  locked operation still carries the lower-rung guards (transfer reuses
  `applySpendPlan` / `applyChargePlan`), and the lock's job is the
  pair-serialization the guards don't provide. `trySerialized` is the
  non-blocking variant for periodic jobs that must yield rather than queue.
- **Raw lock SQL lives only in `uow.ts`** (beside its `SET TRANSACTION`),
  reached through `uow.serialized` — never from a service or repo directly.
  `locks.ts` stays pure — the key registry and the `orderLocks` law, lint-enforced
  free of I/O — so the deadlock-freedom guarantee is a property, not a side effect.

Reads inside a locked or snapshot section run on the `tx` handle the rung passes
in — never `db.ro` or a module-level client, which would read outside the
transaction's (and the lock's) protection.

### The graduation rule

Layers are added when their first real content appears, **not before**:

- No decisions (plain CRUD/projections) → `repo + schema` only. `post/` stops
  here; its mutations call repo write functions directly on `ctx.write` (they
  accept the Pothos `query`, so no re-fetch is needed).
- No decision but an external dependency → `provider + service` (no core). The
  service is thin: it exists to hold the injected port in the container and give
  tests a fake seam, not to decide. `search/` is this point on the spectrum (the
  ES index port behind a passthrough service); it graduates a core when its
  first real rule appears (a filter policy, ranking weights).
- The first decision (state machine, computed plan, cross-row rule) earns a
  pure core file and a service; from then on mutations go service-first and
  re-fetch with `query`. `user/` and `point/` live here.
- Full hexagonal (domain entities mapped both ways, no Prisma types anywhere)
  is deliberately NOT the goal — structural typing does the isolation cheaper.

## 2. Where GraphQL meets the database

- **The Pothos `query` object stops at the repo.** It is Prisma-shaped data (a
  translated selection set), so repo read functions accept and spread it —
  and nothing above the repo ever sees it. Service signatures stay pure domain.
- **Query operations** resolve through repo read functions on `ctx.read`, the
  per-operation routed read client (replica for queries, primary for mutations
  — see README "RWDB / RODB routing"). Its type, `ReadDbClient`, carries only
  the model read methods — no writes, no raw SQL, no transactions — so "the
  query path never writes" is a compile-time fact.
- **Mutations** call the use-case, then re-fetch the result by id with `query`
  on `ctx.read` (the primary during mutations → read-your-writes). A tier-1
  module (no service) executes its single-statement repo write on `ctx.write`
  instead — always the primary, typed `DbClient`, so a resolver cannot open a
  transaction through it (multi-statement writes belong to a use-case + `uow`).
- **Use-cases read and write `db.rw` only.** Deciding on replica-lagged state
  is a correctness bug, not a performance tradeoff.
- **Repos never pick a client** — it is always the caller's first argument:
  `ReadDbClient` for read projections (rw, ro, and tx handles all satisfy it),
  `DbClient` for writes and plan executors.
- **When Pothos cannot hand you a `query`** — the selection is nested under a
  wrapper type, or the ids come from OUTSIDE the database (a search index) —
  the schema layer builds it by hand with `queryFromInfo({ path: [...] })`. That
  is the ONE place a `query` is constructed rather than received from
  `t.prismaField`; its output is the same Prisma-shaped object and still STOPS
  at the repo. A repo `findByIds(ids, query)` then hydrates, restoring the
  external order and skipping drift (ids the index has but the DB no longer
  does). See `modules/search/`. The same `queryFromInfo({ path })` maps a
  payload/union `...Response` mutation result, not just search.

## 3. Invariants as code (and as constraints)

- **Total functions over partial ones.** A core function must be defined for
  every value of its input type, so a property test can throw arbitrary inputs
  at it (`canTransition`, `planSpend`).
- **Name the rule, use it everywhere.** Encode each rule as a named predicate
  (`canTransition`, `isEmail`, `isValidPointAmount`) and make higher-level
  functions defer to it. `assertTransition` is just `canTransition` + throw.
- **Expected violations are `DomainError`s** (`src/foundation/errors.ts`) — including
  `ConcurrentUpdateError` for lost optimistic races. The shell maps them to
  client-visible errors; anything else is masked.
- **Corruption is not a DomainError.** A value that a correct system can never
  produce (an out-of-set status, a ledger that doesn't cover its snapshot) is
  *parsed* (`parseUserStatus`, `parsePointChargeState`) and throws a plain,
  masked Error — never silently coerced to a default.
- **The database backs the value sets.** Transition rules live in code (single
  source of truth); the value sets and signs also live in CHECK constraints
  (`User_status_check`, `PointCharge_state_check`, non-negative amounts), so a
  bypassing writer cannot persist garbage. `integrations/schema-constraints.test.ts`
  keeps code and constraints in sync.

## 4. Value objects — parse, don't validate

Push validation to the boundary and encode the result in the type.

```ts
// user.value.ts — the ONLY way to get an Email is to parse one
export type Email = string & { readonly [brand]: 'Email' };
export function parseEmail(raw: string): Email { /* normalize + validate or throw */ }
```

```ts
// user.service.ts — parse once, at the edge; the repo takes the branded type
const data = { email: parseEmail(input.email), name: input.name ?? null };
```

Downstream code receives an `Email`, not a `string`, so it never re-checks the
invariant. The same applies to reads: DB strings become `UserStatus` /
`PointChargeState` only through their parse functions.

Core input types are **narrow and structural** (`ChargeBalance`,
`{ name: string | null }`): they state what the decision needs, Prisma rows
satisfy them structurally (or via a one-line mapping in the repo), and the core
stays Prisma-free.

## 5. Composition, not containers

- Services are **factory functions** returning records of closures
  (`createPointService(db)`); the container is a plain object built once in
  `createServices()` (`services.ts`, beside the composition root — it is
  transport-agnostic, consumed by both the GraphQL context and the OAuth route),
  where cross-service wiring happens explicitly. `Services` is
  `ReturnType<typeof createServices>` — one edit.
- External dependencies are **ports as function records**
  (`GoogleOAuthClient`), bound to an unimplemented stub in production and an
  object-literal fake in tests. Injectable seams for tests are also plain
  function parameters (`OnboardingServiceDeps.createPost`).
- **Cross-module use-cases** (onboarding) open ONE `db.rw.$transaction` and
  compose the other modules' repo write functions inside it; decisions still
  come from each owning module's core. Module services depend one way only.
- The schema is assembled from **explicit register functions** called once in
  `schema.ts` — no side-effect imports, no import-order contract beyond
  "builder first". The e2e SDL snapshot guards the result.
- A module's outermost layer is its **delivery**, and it lives in a named place:
  GraphQL fields in `schemas/` (or a single `*.schema.ts`), an HTTP surface in
  `routes/*.route.ts`. Both get their service from the container at registration
  (`register<Name>Schema()` in `schema.ts`; `registerXxx(app, service)` in
  `buildApp()`), never a db handle — so the domain layers (core/repo/service/
  provider) stay transport-agnostic and a module can be delivered over GraphQL,
  HTTP, both, or neither (a pure cross-module use-case like `onboarding/`). This
  is why modules are grouped by **domain, not by transport**: `auth/` reuses the
  `user` service, so a GraphQL/REST split would only fragment shared logic.

## 6. Property-based testing

Tests assert **laws**, not examples. Tooling: [`@fast-check/vitest`](https://github.com/dubzzz/fast-check)
(`test.prop`). Test files: `*.prop.test.ts`, beside the module's other tests in
`src/tests/modules/<name>/`; generators shared across a module's tests live in
`<name>.arbitraries.ts` (a single prop file may keep one-off generators inline).

Laws worth reaching for:

| Law            | Example                                                              |
| -------------- | -------------------------------------------------------------------- |
| Totality       | `planSpend` returns a plan or throws one of its named errors — nothing else |
| Conservation   | allocations sum exactly to the requested amount                      |
| Idempotence    | `parseEmail(parseEmail(x)) === parseEmail(x)`                        |
| Agreement      | plan returned ⇔ amount valid and covered (single source of truth)   |
| Terminal state | `∀ to: !canTransition('DEACTIVATED', to)`                            |
| Order          | allocations are an in-order subsequence of the charges (FIFO)        |

Generate **consistent worlds** (see `arbLedger`: charges plus the snapshot
derived from them) so properties exercise the states a correct system can
reach; corruption paths get their own explicit tests.

### Stateful shells → model-based PBT

For a shell with state (e.g. user status in the DB), use `fc.commands` +
`fc.asyncModelRun`: replay a random sequence of operations against both a tiny
in-memory **model** (the spec) and the **real** service, asserting they never
diverge. See `src/tests/modules/user/user.service.model.test.ts`.

## 7. Naming & layout

```
src/
  modules/<name>/
    <name>.core.ts      # pure: decisions, plans, invariants (alt: .state.ts / .value.ts)
    <name>.repo.ts      # Prisma: projections (accept `query`) + plan executors
    <name>.service.ts   # use-cases: read → decide → execute on db.rw
    schemas/            # GraphQL delivery, split by kind (see §5 for the
      <name>.type.ts    #   single-file *.schema.ts alternative)
      <name>.query.ts
      <name>.mutation.ts
    routes/             # optional HTTP delivery (peer of schemas/):
      <name>.route.ts   #   registerXxx(app, service)
    <name>.provider.ts  # optional external port (function record + stub)
  tests/
    support/            # helpers.ts: in-process PGlite + introspection-driven resetDb
    modules/<name>/     # mirrors src/modules/<name>/, suffix = layer:
                        #   .test.ts / .prop.test.ts / .model.test.ts + arbitraries
    integrations/       # cross-module + DB-constraint tests, no transport
    e2e/                # app.inject: flows, schema snapshot, rw/ro routing
```

Tests run on real Postgres with no external server: `makeTestPrisma()` starts
an in-process PGlite database per test file and applies the committed
migrations. PGlite is single-connection, so concurrency guards are written to
be testable sequentially: decide on a snapshot, invalidate it, execute, and
assert the guarded write refuses. The other half of the race story — a real
serialization failure (P2034 → `CONFLICT`) — is inherently untestable on one
connection and is covered by the structural mapping alone; its worst failure
mode is a masked 500, never a double-spend.

Migrations are hand-written SQL applied by tests onto fresh databases, which
is the ONLY reason editing one in an open PR is acceptable — never edit a
migration any environment has already applied; ship a new one.

## 8. Checklist for a new module

1. Model the data in `prisma/schema.prisma`; encode value sets / signs as
   CHECKs in the migration; `migrate` + `generate`.
2. Write `<name>.repo.ts` and the schema register function(s); call them in
   `schema.ts`. Stop here if the module has no decisions.
3. When the first decision appears: put the rules in a pure core file — total
   functions, named predicates, plans that carry their assumptions,
   `DomainError`s for violations, parse functions for DB values.
4. Write `<name>.service.ts` (read → decide → execute inside `uow.run` /
   `uow.snapshot`, or `uow.serialized` if it needs a lock — the weakest rung of
   the concurrency ladder that holds the invariant) and register it in
   `createServices()`. Switch the module's mutations to service-first + re-fetch.
5. Add the module's tests under `src/tests/modules/<name>/`: example tests,
   property tests for the core's laws (generators in `<name>.arbitraries.ts`),
   an integration test for the shell including the lost-race path, and a
   model-based test if the shell is stateful. Update the SDL snapshot.
