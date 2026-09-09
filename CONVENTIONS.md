# Coding Conventions

How this codebase is organized so that **invariants are first-class**, the
code is **property-based-testing (PBT) friendly**, and the GraphQL schema, the
database, and the domain logic stay **cleanly separated**.

## 1. Layers: decide in the core, execute in the shell

Every module splits into explicit layers with one-way dependencies:

| Layer            | Files                                | Speaks                          | May import                                   | Tested with                |
| ---------------- | ------------------------------------ | ------------------------------- | -------------------------------------------- | -------------------------- |
| Core (pure)      | `*.core.ts`, `*.state.ts`, `*.value.ts`, `*.content.ts` | domain types, plans | types + other pure modules, `errors.ts`      | unit + **property** tests  |
| Repo (DB)        | `*.repo.ts`                          | Prisma rows, the Pothos `query` | core types, `@prisma/client`, `db.ts` (`DbClient` / `ReadDbClient` / `Selection`), `prisma-errors.ts`, `errors.ts` | integration (PGlite)       |
| Service (use-cases) | `*.service.ts`                    | domain inputs/outputs only      | core, repo, `uow.ts` / `lock-registry.ts`, `flag-registry.ts` (the `FlagReader` *type*), `db.ts` (the `Db` handle), `@prisma/client` (row types), `errors.ts` | integration + **model** PBT |
| Delivery (edge)  | `schemas/*` or `*.schema.ts` (GraphQL); `routes/*.route.ts` (HTTP); `jobs/*.job.ts` (Agenda) | GraphQL types + `ctx`, Fastify req/reply, or an Agenda job | builder, core (enums/parsers), repo (reads; in a tier-1 module also writes), services (via `ctx` or registration) | e2e (`app.inject`), job-registry + service tests |

```
schema ──→ service ──→ repo ──→ prisma
   │           │          │
   └───────────┴──────────┴──→ core          core → (nothing)
   └─(reads; tier-1 writes)─→ repo
```

**Enforced by oxlint** (`.oxlintrc.json` `no-restricted-imports` per layer), so
these are not just guidelines: the core cannot import Prisma/GraphQL/repos,
services and repos cannot import the builder or Pothos, schema files cannot
import the db handles, the core/repo/schema layers cannot import
`uow`/`locks`/`lock-registry` or the flag facade
(`flags`/`flag-registry`/`flag-reader`) — only a service opens a transaction or
takes a lock, and only the delivery/service layer is handed a flag reader (a core
receives a flag value as passed-in data). A service may import the `FlagReader`
*type* but not the OpenFeature SDK or the reader factory; `builder.ts` cannot
import feature modules, and `import/no-cycle` keeps the file graph acyclic.

The **shape** of the module graph is checked separately by dependency-cruiser
(`pnpm check:graph`, rules in `.dependency-cruiser.mjs`), which sees what
per-file lint cannot:

- **No cycles of value imports.** `import type` is erased at compile time and
  is the sanctioned cycle breaker (`builder.ts` → `context.ts`,
  `context.ts` → `services.ts`), so only value edges count.
- **Cross-module dependencies come from an explicit allowlist** — today
  `onboarding → {user, post}`, `search → post`, and `auth → user` (types
  only; the service arrives injected). Two modules can entangle with no
  file-level cycle (`user/a.ts → post/x.ts` plus `post/y.ts → user/b.ts`),
  which `import/no-cycle` cannot see — the allowlist can, and since its
  sanctioned edges form a DAG by construction, module-level acyclicity holds
  unless the allowlist itself is edited, which is the review point. Whether a
  change earns a new module or a new edge at all is §11's decision procedure.
- **The composition root stays at the top**: nothing below `app.ts` /
  `services.ts` / `server.ts` may import them as values.

Two rules
the linter cannot see, reviewed by hand:

- **A business `if` in a service or repo is a leaked decision** — move it to
  the core. The only branching allowed in the execute phase is the mechanical
  mapping of plan fields (`a.depleted ? 'CONSUMED' : undefined`).
- **`await` never appears in a core file.** Its time-analogue —
  `new Date()` / `Date.now()` never appears in a core either (reading the clock is
  I/O; `now` arrives as a parameter) — IS lint-enforced; see §10 "Time".

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

See `point.core.ts` (`planSpend`) / `point.write.repo.ts` (`applySpendPlan`) /
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

- **Keys come from one registry (`lock-registry.ts`), acquired in one global
  order.** Two transactions locking an overlapping set cannot deadlock because
  every caller sorts the keys the same way (`orderLocks` — pure, property-tested).
  Append a new namespace at the END; never reorder.
- **A lock only serializes writers that take the SAME key.** Mixing a locked
  writer with a lock-free one that touches the same rows protects nothing — so a
  locked operation still carries the lower-rung guards (transfer reuses
  `applySpendPlan` / `applyChargePlan`), and the lock's job is the
  pair-serialization the guards don't provide. `trySerialized` is the
  non-blocking variant for periodic jobs that must yield rather than queue.
- **Raw lock SQL lives only in `uow.ts`** (beside its `SET TRANSACTION`),
  reached through `uow.serialized` — never from a service or repo directly.
  `lock-registry.ts` (the key registry) and `locks.ts` (the `orderLocks` law and
  the `defineLocks` builder) stay pure, lint-enforced free of I/O — so the
  deadlock-freedom guarantee is a property, not a side effect.

Reads inside a locked or snapshot section run on the `tx` handle the rung passes
in — never `db.ro` or a module-level client, which would read outside the
transaction's (and the lock's) protection.

### The graduation rule

Layers are added when their first real content appears, **not before**:

- No decisions (plain CRUD/projections) → `repo + schema` only. `post/` stops
  here; its mutations call repo write functions directly on `writer(ctx)` (they
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
- **The `query` parameter is always typed `Selection<'Model'>`** (from
  `db.ts`, keyed by model name: `Selection<'Post'>`) — `select`/`include`
  only, never a Prisma `...Args` type. There is one answer to "what goes
  here": the Pothos `query` from a resolver, nothing from anywhere else (it
  defaults to `{}`). `where`/`orderBy`/pagination cannot ride in through the
  selection channel; filters and ordering enter as named parameters
  (`findMany(db, query, { onlyPublished })`).
- **A resolver has ONE database handle, `ctx.db`** — the per-operation routed
  client (replica for queries, primary for mutations — see README "RWDB / RODB
  routing"). Its type, `ReadDbClient`, carries only the model read methods — no
  writes, no raw SQL, no transactions — so "a resolver cannot write through
  `ctx.db`" is a compile-time fact, uniform across queries and mutations. One
  name, not a read/write pair the author has to choose between.
- **Query operations** resolve through repo read functions on `ctx.db`.
- **Mutations** call the use-case, then re-fetch the result by id with `query`
  on `ctx.db` (the primary during mutations → read-your-writes). A tier-1
  module (no service) executes its single-statement repo write through
  `writer(ctx)` — the ONE widening of the routed client back to a full
  `DbClient`. It is runtime-guarded (throws outside a mutation) and honest
  (during a mutation `ctx.db` already IS the primary); a resolver still cannot
  open a transaction through it, so multi-statement writes stay with a use-case
  + `uow`. `writer(ctx)` at a call site reads as "tier-1 direct write here".
- **Use-cases read and write `db.rw` only.** Deciding on replica-lagged state
  is a correctness bug, not a performance tradeoff.
- **Repos never pick a client** — it is always the caller's first argument:
  `ReadDbClient` for read projections (rw, ro, and tx handles all satisfy it),
  `DbClient` for writes and plan executors.
- **When the root resolver is not handed a `query`** — the model selection is
  nested under a wrapper type, or the ids come from OUTSIDE the database (a
  search index) — make the wrapper field that owns the selection a
  `t.prismaField` of its own: the root resolver returns domain data (ids,
  totals), and Pothos hands THAT field its `query`, created exactly where it
  is consumed. A repo `findByIds(ids, query)` then hydrates, restoring the
  external order and skipping drift (ids the index has but the DB no longer
  does). See `modules/search/`. Only when a field cannot be a prismaField —
  its type is a union of several models (a `...Response` payload, a mixed
  feed) — does the schema layer build the per-member query by hand with
  `queryFromInfo({ path: [...] })`; its output is the same Prisma-shaped
  object and still STOPS at the repo.

### Per-parent reads and aggregates (the no-N+1 rules)

A field that needs data *per parent node* — the author of each post, how many
posts each user has — is resolved by riding the PARENT's one query, never by a
repo call inside the field resolver. That call is the N+1 smell; and "fixing"
it by importing another module's repo from a repo is the coupling these rules
exist to prevent. Pick the first rung that fits:

| Per-parent need | Tool | Worked example |
| --- | --- | --- |
| follow a relation | `t.relation` (+ the `query` spread in the root resolver) | `Post.author`, `User.posts` |
| count a relation (optionally filtered) | `t.relationCount` | `User.postCount` / `publishedPostCount` (post module) |
| an aggregate with domain meaning (a balance, a total) | materialize it as an owned row, kept consistent by the owning module's plan executors; expose with `t.relation` | `PointBalance` |
| an aggregate over the page, not the node | a wrapper-type field computed once per request | `SearchPostsResult.total` |
| rows for ids from OUTSIDE the database | repo `findByIds` + `queryFromInfo` | `search/` |

The first two rungs compile into the parent's single Prisma query (`include` /
`_count` sub-selects), so a list of N parents resolves in one statement — the
query-merging equivalent of a DataLoader with none of the per-request
machinery. Even off the happy path (a prisma object reached without a `query`,
e.g. under a hand-built wrapper) the plugin falls back to Prisma's fluent API,
whose same-tick `findUnique` batching still collapses N lookups into one `IN`
query. `tests/e2e/query-batching.test.ts` pins the law that matters: the SQL
statement count is FLAT in the row count (per level, never per row).

Two structural rules fall out:

- **Repos never import another module's repo.** Cross-module READ composition
  is *declared*, not called: the relation lives in `schema.prisma`, and the
  module that owns the aggregated rows attaches the field to the other
  module's object with `builder.prismaObjectField` (see the post counts on
  `User`, registered in `post/schemas/post.type.ts`) — the schema-layer
  analogue of onboarding's service-level WRITE composition. Neither module's
  repo learns about the other; a filtered count's `where` is declarative
  plugin config, not a filter smuggled through a repo signature.
- **A DataLoader is earned, not default** (the graduation rule again). It
  enters only with the first per-parent source Prisma cannot see — an external
  port fanned out per node. When that day comes, the batch function is a repo
  projection (`findByIds` is already loader-shaped: ids in, order restored,
  drift skipped) and the loader itself is per-request state on the context,
  beside `ctx.flags`' memoization — services never see it. Until then, a
  loader would re-implement what the query merge already guarantees.

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

This is also what lets a **repo write function be composed from another module
without leaking the ability to break its invariant.** Because the write takes
the branded value (`createUser(tx, { email: Email })`), a caller in a different
module — `onboarding` opening one transaction over `userRepo.createUser` +
`postRepo.createPost` (§5) — cannot hand it un-parsed input; the type forces the
decision back through the owning module's core. So the rule for any write that
carries an invariant: **take a type only the core can mint** — a branded value,
or a plan (the plan pattern, §1) — never a raw shape. Then the function can be
reached across the allowlist without the invariant leaking with it.

An invariant a single value's type *cannot* capture — a legal status transition,
a cross-row rule — stays in the **service**, not in the write function's
signature (`changeStatus` decides over the CAS `transitionStatus`; `spend`
decides over `applySpendPlan`). Such a write must **not** be reached from another
module: nothing here forces its caller back through the core, so the cross-module
allowlist (§5, `pnpm check:graph`) is what holds that line — it guards edges at
the file level and cannot tell one exported function from another in the same
repo, so keeping these writes off the allowlist is a review-time rule, not a
type-level one.

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
  come from each owning module's core. Module services depend one way only —
  enforced by the cross-module allowlist in `.dependency-cruiser.mjs`
  (`pnpm check:graph`). When a use-case earns this shape — and when a
  cross-module edge is allowed at all — is decided by §11.
- The schema is assembled from **one register function per module** —
  `registerXxxModule()` in that module's `schemas/index.ts`, called once in
  `schema.ts`. No side-effect imports, no import-order contract beyond
  "builder first"; **intra**-module ordering (e.g. user types before user
  mutations, so the shared enum ref exists) lives inside that module's register
  function, not in `schema.ts`'s line order. The index is a composition point,
  NOT a barrel — it calls the register functions, it never re-exports the
  module's core/repo/service, so the file-name lint globs stay intact. The e2e
  SDL snapshot guards the result.
- A module's outermost layer is its **delivery**, and it lives in a named place:
  GraphQL fields in `schemas/` (or a single `*.schema.ts`), an HTTP surface in
  `routes/*.route.ts`, scheduled background jobs in `jobs/*.job.ts`. Each gets
  its service from the container at registration (`registerXxxModule()` from
  `schemas/index.ts`, called in `schema.ts`; `registerXxx(app, service)` in
  `buildApp()`; `registerXxxJobs(agenda, service)` in `buildScheduler()`), never
  a db handle — so the domain layers (core/repo/service/provider) stay
  transport-agnostic and a module can be delivered over GraphQL, HTTP, scheduled
  jobs, any combination, or none (a pure cross-module use-case like
  `onboarding/`). A job handler is as thin as a route: it delegates the decision
  + write to the service, which reads `now` from the injected clock (§10 — time
  enters through that seam, not the handler). This is why modules are grouped
  by **domain, not by transport**: `auth/` reuses the `user` service, so a
  GraphQL/REST split would only fragment shared logic.

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
                        #   (when it grows: split .read.repo.ts / .write.repo.ts)
    <name>.service.ts   # use-cases: read → decide → execute on db.rw
    schemas/            # GraphQL delivery, split by kind (see §5 for the
      index.ts          #   registerXxxModule(): the module's ONE entry point
      <name>.type.ts    #   (single-file *.schema.ts alternative also in §5)
      <name>.query.ts
      <name>.mutation.ts
    routes/             # optional HTTP delivery (peer of schemas/):
      <name>.route.ts   #   registerXxx(app, service)
    jobs/               # optional scheduled delivery (peer of schemas/):
      <name>.job.ts     #   registerXxxJobs(agenda, service): JobSchedule[]
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

0. Confirm the change earns a module at all (§11): rows an existing module
   owns → extend it; a new noun → a new owner module; a capability above the
   owners (a cross-owner use-case, an external port or protocol) → a
   composite module; and walk the coupling ladder before taking any
   cross-module edge.
1. Model the data in `prisma/schema.prisma`; encode value sets / signs as
   CHECKs in the migration; `migrate` + `generate`.
2. Write `<name>.repo.ts` and the schema files, compose their register
   function(s) into `registerXxxModule()` in `schemas/index.ts`, and call that
   one function in `schema.ts`. Stop here if the module has no decisions.
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

## 9. Feature flags

Feature switches go through [OpenFeature](https://openfeature.dev). The code
depends only on the vendor-neutral SDK; a **provider** plugs in behind it, so the
backend (a DB table today, flagd/Unleash/LaunchDarkly later) is swappable with no
call-site edits. This is the same port/adapter shape as `GoogleOAuthClient` and
`PostSearchIndex` — the seam is OpenFeature's `Provider` interface.

**The read facade mirrors the locks split** (`db/locks.ts` + `db/lock-registry.ts`),
one machinery file and one growing registry, both pure and lint-enforced free of
I/O:

- `flags/flags.ts` — machinery: the flag spec kinds, `defineFlags`, and the derived
  `FlagReader` type. Imports nothing (not even the SDK).
- `flags/flag-registry.ts` — the ONE place that says WHAT is flag-gated (`FLAGS`):
  each flag's kind, its default, its lifecycle, and its JSDoc. Add a flag here;
  the machinery is fixed.
- `flags/flag-reader.ts` — the `uow.ts` analogue: the I/O shell that binds the
  registry to the OpenFeature client per request. The only facade file that imports
  the SDK. Reads are **memoized per request**, so a flag read in a resolver and
  again in the service it calls can't disagree — the reader-level version of
  `uow.snapshot`'s single-consistent-world guarantee.

`ctx.flags` is that per-request reader (built in the context factory beside the
`ctx.db` routing). A gate's default is its **safe fallback**, single-sourced in the
registry — for a crepe-backed gate that is `false` (INACTIVE), so a missing or
misconfigured backend fails every gate closed.

**Where a flag branch lives — the rule that keeps `if`-sprawl out of services:**

| Flag use | Cost in the service | Where the branch lives |
| --- | --- | --- |
| Kill / rollout gate | one `flags.assert.x()` line | machinery (throws `FeatureDisabledError` → `UNAVAILABLE`) |
| Rule change (a limit, a cutoff) | one read in the read phase, passed as data | the pure **core** (a property test then covers both sides for free) |
| Implementation swap | a typed `Record<Variant, Impl>` lookup | the **type** (exhaustiveness), never an `if`-chain |

All three modes ship as worked examples:

- **Mode 2 (gate):** `point.transfer` calls `flags.assert.pointTransfer()` as its
  first line — in the **service**, not the resolver, because the service is the
  choke point every caller passes through (a future job or route is gated too).
- **Mode 1 (rule change):** the same `transfer` reads `flags.pointTransferPreferFree()`
  and passes the boolean into `planSpend` (core), which branches on it — no `if` in
  the shell, and a property test covers both spend orderings.
- **Mode 3 (variant):** `onboarding.register` reads `flags.welcomeVariant()` and the
  onboarding core picks the welcome-post builder from an exhaustive
  `Record<WelcomeVariant, …>` (a new variant without a builder is a compile error).

The reader always arrives as a per-call argument (`ctx.flags`), exactly as `ctx.db`
reaches a repo — a singleton service never stores request state. A business flag
`if` appearing in a service body is the same smell as any leaked decision: push the
branch to the core (as data) or to the gate.

**Lifecycle — the code-level purge.** A flag lives in two places, and each needs a
way to die. The DB half has one (live → soft-deleted → hard-deleted after
`PURGE_RETENTION_DAYS` by the `feature-flag:purge-deleted` job); the CODE half —
the registry entry and its call sites — gets its own, or it lives forever. Every
spec therefore declares `permanent` (a kill switch or ops toggle, allowed to stay;
say why in its doc) or `temporary('YYYY-MM-DD')` (a rollout/experiment flag that
must be DELETED from the registry by that KST day). `flag-hygiene.test.ts` fails
the build once a temporary flag outlives its `removeBy` (`expiredFlags`, the
`purgeCutoff` analogue) — and deleting the entry turns every call site into a
compile error, so the compiler drives the code purge the way the job drives the DB
one. This matters doubly here because a gate's default is `false`: a fully
rolled-out feature stays gated on a live DB row until the code stops asking, so
removing the gate IS the last step of the rollout. The purge job also runs
`featureFlag.reconcile()` BEFORE sweeping (a soft-deleted row is the only witness
that a declared flag was killed — the purge erases exactly that witness), logging
live rows no entry declares (`orphanLive`) and declared names whose only rows are
soft-deleted (`killedButDeclared`) through the scheduler's logger. The registry's
keys reach the service as data from the composition root — the job layer is
lint-banned from the flag facade, like every layer below delivery. The reference's
`removeBy` dates are set far ahead so the worked examples stay green; a real app
sets real deadlines.

**Enforcement** (lint, like the locks layer): the core, repo, and schema layers
cannot import the facade at all (`flags`/`flag-registry`/`flag-reader` — all three
globs, because `**/flags*` does NOT match `flag-registry`/`flag-reader`); a service
may import the `FlagReader` *type* from the registry but not the SDK or the reader
factory; a `*.provider.ts` may read via `db` + a repo and speak its SDK but knows
no schema, transport, or transaction.

**The provider adapter** (`modules/feature-flag/`) is the crepe model: a
`FeatureFlag` row is active only for the deploy `STAGE`, inside its
`[enableAfter, disableAfter]` window, and while not soft-deleted. That rule is the
pure predicate `isActive` (the provider fetches the row and supplies `now` — a
business `if` in the provider would be a leaked decision), backed by DB CHECK
constraints on the stage value set and window ordering, and a partial unique index
(`name` WHERE `deletedAt IS NULL`) for one-live-row-per-name. The provider is a
**class** (the sanctioned exception to the factory-function norm — it implements the
SDK's `Provider` interface, like the SDK's own `InMemoryProvider`). Writing flags is
the module's admin service; a staff-gated delivery (route or authorized mutation) is
a future addition, blocked today only by the absence of an authorization layer.

## 10. Time

Reading the current time is **I/O**, and it enters the domain exactly as the
database and the flag reader do — through a seam, as passed-in data — never as an
ambient `new Date()` buried in a decision. Two seams, two files:

- **`foundation/clock.ts`** — the `Clock` port (`{ now(): Date }`) that MINTS the
  instant. Production binds `systemClock` (the one sanctioned `new Date()`); tests
  inject a fixed clock (`src/tests/support/clock.ts`). Bound once in the
  composition root (`createServices` / `buildApp`) and shared by every service and
  provider that reads time.
- **`foundation/time.ts`** — the pure calendar module, and the codebase's SINGLE
  date-library seam. Instant→calendar reasoning (KST day boundaries, `addDays`,
  later formatting/durations) lives behind pure functions here; a `Dayjs` value
  never crosses its interface, exactly as a Prisma row never crosses a repo's.

Minting and calendar math are **different seams**. crepe conflates them in a
single `dayjs()` call in ~80 files (and monkey-patches the `Dayjs` prototype in
`lib/dayjs.ts`); the refactor splits them — `clock.now()` for the instant,
`time.ts` for the reasoning — which is what makes time both injectable and
library-swappable.

### now is a field of the world snapshot

`now` belongs to the **read** phase of read → decide → execute, mixed with the
rest of the world, and it is minted **once**:

| Layer | Rule | Worked example |
| --- | --- | --- |
| core (`*.core.ts`) | takes `now: Date` as a parameter; never mints it. Calendar math via `time.ts`. | `planExpiry(world, now)`, `isActive(row, stage, now)` |
| service (`*.service.ts`) | reads `clock.now()` ONCE at the top of the read phase (or takes an explicit `now` for a backfill) and passes it to the core | `point.expire` |
| repo (`*.repo.ts`) | never mints a decision time; a domain instant is passed in | `feature-flag.softDelete(tx, id, deletedAt)` |
| provider (`*.provider.ts`) | reads the injected clock, not `new Date()` | `DbFeatureFlagProvider` window eval |
| policy cutoff | a `Date` constant in the core, shared with tests | (crepe's `FEEDBACK_DUE_AT_5D_CUTOFF`) |

Reading `now` twice inside one decision is the same bug as reading the DB twice
without a snapshot: a midnight (or month-end) boundary can fall between the two
reads and the decision sees an impossible world. One mint per request/job fixes
it; the request is then a deterministic function of `(state, input, now)`.

### The two clocks

There are two clocks — the app clock (`clock.now()`) and the DB clock
(`@default(now())`, `@updatedAt`). A decision that compares an injected `now`
against a DB-written timestamp straddles both. In production the skew is
milliseconds against day-granular rules, so it is harmless; in tests it is a
trap (a fixed clock at 2026-01-01 vs PGlite's real `now()` on `@default` rows).
Three rules keep a time decision single-clocked and deterministic:

1. **A decision-relevant timestamp is stamped by the plan, from the app clock —
   not `@default(now())`.** `ExpiryPlan.expiredAt` carries the decision's `now`;
   `applyExpiryPlan` writes it. The DB default is a backstop, never the value a
   decision reads back.
2. **A decision never reads a raw audit column** (`createdAt` / `updatedAt`). The
   moment a rule needs a timestamp, that timestamp is a *domain* fact and pays the
   **promotion cost**: (a) the write is owned by the decision path (stamped
   explicitly, not left to the DB), (b) it gets a domain name (`chargedAt`,
   `expiredAt`, `deletedAt` — never a reused `createdAt`), and (c) tests set it
   explicitly. `updatedAt` especially is off-limits as an input — it means "any
   write touched this row", so an unrelated update silently moves it.
3. **Tests inject a fixed clock and arrange explicit timestamps** — never
   `vi.useFakeTimers` (it freezes only the app clock; the DB clock keeps running,
   so the two diverge) and never real-time offsets like `new Date(Date.now() ±
   n)` (flaky at boundaries). See `point.expiry.test.ts` (fixed clock + backdated
   `chargedAt`) and `feature-flag.provider.test.ts` (a fixed `NOW`, window bounds
   relative to it).

Comparing two *stored* timestamps is safe — one clock, no `now` (the FIFO spend
sorts `chargedAt` values, it does not read `now`). Only a comparison against
"now" needs the rules above.

The decision is evaluated **at the snapshot's `now`**: a plan valid when the world
(including `now`) was read is valid, even if a boundary passes before it commits —
the same contract `uow.snapshot` gives for row reads. When "still valid at write
time" is itself the invariant, put the time predicate in the SQL `WHERE` (an
optimistic guard), which unifies that decision on the DB clock; treat it as a last
rung, like the advisory lock, because a DB `now()` cannot be pinned in tests.

### Storage

Instants are stored as `timestamptz(6)` (a JS `Date` is an instant), not
`timestamp without time zone` — matching crepe and keeping `AT TIME ZONE` / KST
math honest.

### Enforcement

- **`new Date()` / `Date.now()` anywhere but `foundation/clock.ts`** → oxlint
  `no-restricted-globals` bans the `Date` global as a VALUE repo-wide (cores get a
  stricter message; `clock.ts` and tests are excepted), fencing the clock the way
  the rule below fences the date library. The `Date` *type* in annotations is
  fine. In a core it is the time analogue of the hand-reviewed "no `await` in a
  core".
- **A core importing `clock.ts`** → the core `no-restricted-imports` group (beside
  the db/flag bans). A core may import `time.ts` (pure).
- **Any file but `time.ts` importing a date library** → dependency-cruiser
  `date-lib-lives-in-time-only` (matches dayjs/luxon/moment/date-fns/@js-joda by
  name, so a newly-added lib is fenced immediately), keeping the swap seam across
  the whole tree, shell included. A Temporal migration would target a global, so
  it would instead be fenced by a `no-restricted-globals` entry.

The KST day-boundary math itself is fixed-offset (UTC+9) arithmetic, deliberately
NOT `dayjs.tz('Asia/Seoul').endOf('day')`: dayjs's tz/`endOf` consults the server
zone and is off by an hour when the process TZ is mid its OWN DST transition, so
the boundary must not depend on `process.env.TZ`. `time.test.ts` pins this against
a pure-arithmetic oracle; run CI under a non-UTC `TZ` to lock it in.

### crepe migration map

| crepe today | gannet blueprint |
| --- | --- |
| `dayjs()` / `new Date()` ambient in services, resolvers, repos | `clock.now()` once in the service read phase; `now` passed as data |
| `now: dayjs.Dayjs` across interfaces; `dayjs` imported in ~80 files | `now: Date` across interfaces; `dayjs` only in `foundation/time.ts` |
| `dayjs().kst().startOf('day')` inline; `lib/dayjs.ts` prototype patches | pure `time.ts` functions (`kstEndOfDay`, `addDays`) returning `Date` |
| cron `reflectX(now = dayjs().kst())` default arg | service takes explicit `now` (backfill) or the injected clock (scheduled) |
| `vi.useFakeTimers({ toFake: ['Date'] })` | `fixedClock(instant)` injected via `createServices` / `buildApp` |

## 11. Module boundaries — extend, create, or take an edge?

The graduation rule (§1) decides which LAYERS a module has earned; this
section decides which MODULE a change lives in — the question every feature
starts with, one step before §8's checklist. Every change is one of four
answers: extend an existing module, create a new owner module, create a new
composite module, or add a dependency edge to an existing module.

**A module is its ownership.** A module owns a set of Prisma models, the
invariants over them, and the write paths that keep those invariants true.
Everything below follows from asking *"who owns the rows this change must
keep consistent?"* — never from file size, team shape, or transport (§5:
modules group by domain, not transport). Two module shapes exist, and the
distinction organizes the whole graph (`src/modules/README.md`):

- **Owner modules** own tables and their invariants and import no other
  module: `user`, `post`, `point`, `feature-flag`, `ledger`. They are the
  graph's leaves. `ledger` shows that "owner" is about rows and not about
  size: it is the largest module here, and still a leaf, because it owns the
  money rows and names no domain that spends them — a caller hands it a
  reference id and a set of operations, never the other way round.
- **Composite modules** own a *capability* over other modules' nouns, hold
  few or no tables of their own, and compose owners one way from above:
  `onboarding` (a cross-module use-case), `search` (an external index
  hydrated through the post repo), `auth` (an external protocol over the
  injected user service). Nothing imports a composite — it is reached only
  at the composition points (`graphql/schema.ts`, `services.ts`, `app.ts`,
  `scheduler/scheduler.ts`) — and the graph rules keep that true
  mechanically: owners fall under the default-deny rule, each composite has
  a reaches-only rule, and everything else in `src/` is fenced by
  `modules-enter-at-composition-points`.

Code with no Prisma model and no domain rule is not a module at all: shared
machinery lives in `foundation/` / `db/` / `flags/`. A "utils" or "common"
module under `modules/` is a smell — it becomes an edge into everything.

### The decision procedure

Ask in order; the first yes wins.

**Q1 — Same noun?** Does the change only read/write rows an existing module
already owns, refining that module's invariants?
→ **Extend that module.** The graduation rule (§1) picks the layer; §8
steps 3–4 apply when the change brings the module's first decision. New
attribute rows kept consistent by the owning module's plan executors stay
with the owner (`PointBalance` is a point-owned row, not a module). A
junction table belongs to the module whose invariant it carries and whose
aggregate it feeds (a per-post like count would live in `post`). Litmus:
*the module whose write paths keep the row consistent owns it.*

**Q2 — New noun?** Does the change introduce a model with its own lifecycle
and invariants — nameable without reference to an existing noun, kept
consistent by its own writes?
→ **New owner module, born a leaf.** The default-deny rule
(`cross-module-deps-are-allowlisted`) bans cross-module imports for any
module not explicitly exempted, so a new module starts with zero edges
mechanically — creating one needs no allowlist edit, only §8's checklist.
Read composition with existing nouns is declared from the new owner's side
(`builder.prismaObjectField`, §2) and costs no edge.

**Q3 — New capability above the nouns?** Is the change a capability that
refines no single owner's invariants — a use-case whose ONE transaction
composes decisions or writes of two or more owners (register = user +
welcome post), or an external port or protocol layered over an owner's rows
(an index, an OAuth flow)?
→ **New composite module above them** — onboarding, search, and auth are the
three worked shapes. The composite takes the edges; the owners do not
change. Never implement a workflow by adding an edge *between* two owners —
each would eventually need the other, and mutual need is exactly what §5's
one-way rule exists to resist. The Q1/Q3 line: a change that tightens or
extends what is true of an owner's rows extends the owner; a change that
*uses* those rows under a new delivery, external dependency, or cross-owner
transaction is a capability and composes from above.

**Q4 — An existing module needs a new edge?** Only when a use-case that
module already owns genuinely extends into rows another owner keeps:
onboarding starts granting signup points (`onboarding → point`), a future
coupon module's redeem must also spend points (`coupon → point`).
→ **Extend the allowlist** by the procedure below. The edge points from the
use-case owner down to the row owner, and must keep the module graph a DAG.
The moment two modules want edges into EACH OTHER, the answer is never
"allow both": lift the shared use-case into a composite above (Q3), or push
the shared rows down into a new owner both can reach (Q2).

### The coupling ladder

Most "I need module X" needs no edge at all. Before answering Q2–Q4, walk
this ladder and take the weakest rung that works — the module-graph analogue
of the concurrency ladder (§1):

| Rung | Mechanism | Edge | Worked example |
| ---- | --------- | ---- | -------------- |
| 0 | declared read composition: `t.relation` / `t.relationCount` / `builder.prismaObjectField` registered by the row owner (§2) | none | post counts on `User` |
| 1 | the fact arrives as data: a parameter, a flag value, `now` | none | `planSpend` receives the prefer-free boolean |
| 2 | the dependency arrives injected: a deps parameter or `createServices` wiring; the type via `import type` | type-only | `auth → user` |
| 3 | value import of the owner's repo functions: write composition under ONE transaction, or read hydration that must accept the caller's `query` (§2) | value (allowlisted) | `onboarding → {user, post}`; `search → post` |

Rungs 0–1 are free: no graph change, no review trigger. Rung 2 keeps the
runtime decoupled (the seam is wired once in the composition root) and is
preferred whenever a whole use-case — not individual writes — is being
reused. Rung 3 exists for what an injected service cannot give: one `uow`
transaction spanning two owners' writes (onboarding), or a repo read that
must accept the caller's Pothos `query` (search's `findByIds` hydration).
What may cross a rung-3 edge is §4's rule, applied per function: a write
that carries an invariant takes a type only the owning core can mint —
`createUser` takes a branded `Email`, while a tier-1 write like `createPost`
carries none and takes a plain shape — and a write whose invariant lives in
the owning service (a status transition, a cross-row rule) must NOT be
reached across the edge at all.

### Changing the graph: the procedure

The allowlist in `.dependency-cruiser.mjs` is the only gate an edge passes
through, and the edit is deliberately manual — it is the review point:

1. **Name the rung** in the PR description, and why the rungs below it don't
   fit.
2. **Extend the allowlist**: add the module to the default rule's `pathNot`
   exemption if it is not already there, and add — or, when the module
   already has one, widen — its `X-reaches-Y-only` rule (renaming it to
   match); a rung-2 (injected) edge also gets an `X-to-Y-is-type-only` rule.
3. **Keep the DAG visible**: update the edge table in
   `src/modules/README.md` (edge, why, kind) and confirm it stays acyclic —
   module-level acyclicity is guaranteed by the allowlist's shape, not by
   `no-runtime-cycles` (§1), so that table IS the proof the reviewer reads.
4. **Regenerate the pictures** in the same PR: `pnpm graph:modules`.
5. **Reviewer checks what no tool can** — the checklist below.

### Enforcement

Mechanical — CI (`.github/workflows/check.yaml`) runs `typecheck`, `lint`,
`check:graph`, and `test` on every PR (and on push to `main`), so a
violating PR cannot go green:

| Rule | Enforced by |
| --- | --- |
| a new module is born a leaf; owners import no module | dependency-cruiser default-deny (`cross-module-deps-are-allowlisted`) — `pnpm check:graph` |
| a composite reaches only its sanctioned targets | per-module `…-reaches-…-only` rules — `pnpm check:graph` |
| an injected edge stays type-only | `…-is-type-only` rules — `pnpm check:graph` |
| no runtime import cycles | `no-runtime-cycles` — `pnpm check:graph` |
| nothing below the composition root imports it | `composition-root-is-the-top` — `pnpm check:graph` |
| non-module code enters modules only at the composition points | `modules-enter-at-composition-points` — `pnpm check:graph` |
| layer rules inside the module | oxlint `no-restricted-imports` per layer — `pnpm lint` |
| the delivery surface change is visible in review | SDL snapshot test — `pnpm test` |

Human — the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) asks for
exactly the judgments the tools cannot make, so review attention concentrates
where the graph changes:

1. Which of Q1–Q4 the change is; for an edge, why the lower ladder rungs
   don't fit.
2. §4 across the new edge: crossed writes take branded values or plans; no
   invariant-guarding service write is reached from outside its module.
3. Decisions stayed in the owning modules' cores; the composing service opens
   ONE transaction.
4. The README edge table is still a DAG; the SVGs were regenerated.

Left to the adopting team's repository settings: a CODEOWNERS entry on the
boundary files — `.dependency-cruiser.mjs`, `src/modules/README.md`,
`src/services.ts`, `src/graphql/schema.ts`, this file — so every node/edge
change pages a maintainer, and branch protection requiring the `check`
workflow.
