# Coding Conventions

How this codebase is organized so that **invariants are first-class**, the
code is **property-based-testing (PBT) friendly**, and the GraphQL schema, the
database, and the domain logic stay **cleanly separated**.

## 1. Layers: decide in the core, execute in the shell

Every module splits into explicit layers with one-way dependencies:

| Layer            | Files                                | Speaks                          | May import                                   | Tested with                |
| ---------------- | ------------------------------------ | ------------------------------- | -------------------------------------------- | -------------------------- |
| Core (pure)      | `*.core.ts`, `*.state.ts`, `*.value.ts`, `*.content.ts` | domain types, plans | types + other pure modules, `errors.ts`      | unit + **property** tests  |
| Repo (DB)        | `*.repo.ts`                          | Prisma rows, the Pothos `query` | core types, `@prisma/client`, `db.ts`, `errors.ts` | integration (PGlite)       |
| Service (use-cases) | `*.service.ts`                    | domain inputs/outputs only      | core, repo, `db.ts` (`db.rw`), `errors.ts`   | integration + **model** PBT |
| Schema (GraphQL) | `*.schema.ts`, `schemas/*`           | GraphQL types, `ctx`            | builder, core (enums/parsers), repo (reads; in a tier-1 module also writes), services via ctx | e2e (`app.inject`) |

```
schema ──→ service ──→ repo ──→ prisma
   │           │          │
   └───────────┴──────────┴──→ core          core → (nothing)
   └─(reads; tier-1 writes)─→ repo
```

**Enforced by oxlint** (`.oxlintrc.json` `no-restricted-imports` per layer), so
these are not just guidelines: the core cannot import Prisma/GraphQL/repos,
services and repos cannot import the builder or Pothos, schema files cannot
import the db handles, `builder.ts` cannot import feature modules, and
`import/no-cycle` keeps the graph acyclic. Two rules the linter cannot see,
reviewed by hand:

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

### The graduation rule

Layers are added when their first real content appears, **not before**:

- No decisions (plain CRUD/projections) → `repo + schema` only. `post/` stops
  here; its mutations call repo write functions directly (which accept the
  Pothos `query`, so no re-fetch is needed).
- The first decision (state machine, computed plan, cross-row rule) earns a
  pure core file and a service; from then on mutations go service-first and
  re-fetch with `query`. `user/` and `point/` live here.
- Full hexagonal (domain entities mapped both ways, no Prisma types anywhere)
  is deliberately NOT the goal — structural typing does the isolation cheaper.

## 2. Where GraphQL meets the database

- **The Pothos `query` object stops at the repo.** It is Prisma-shaped data (a
  translated selection set), so repo read functions accept and spread it —
  and nothing above the repo ever sees it. Service signatures stay pure domain.
- **Query operations** resolve through repo read functions on `ctx.prisma`,
  the per-operation routed selection client (replica for queries, primary for
  mutations — see README "RWDB / RODB routing").
- **Mutations** call the use-case, then re-fetch the result by id with `query`
  on `ctx.prisma` (the primary during mutations → read-your-writes).
- **Use-cases read and write `db.rw` only.** Deciding on replica-lagged state
  is a correctness bug, not a performance tradeoff.
- **Repos never pick a client** — rw/ro/tx is always the caller's first
  argument (`DbClient`).

## 3. Invariants as code (and as constraints)

- **Total functions over partial ones.** A core function must be defined for
  every value of its input type, so a property test can throw arbitrary inputs
  at it (`canTransition`, `planSpend`).
- **Name the rule, use it everywhere.** Encode each rule as a named predicate
  (`canTransition`, `isEmail`, `isValidPointAmount`) and make higher-level
  functions defer to it. `assertTransition` is just `canTransition` + throw.
- **Expected violations are `DomainError`s** (`src/errors.ts`) — including
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
  `createServices()` (context.ts), where cross-service wiring happens
  explicitly. `Services` is `ReturnType<typeof createServices>` — one edit.
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
    <name>.schema.ts    # register<Name>Schema()  (or schemas/ split: .type/.query/.mutation)
    <name>.route.ts     # optional non-GraphQL surface: registerXxx(app, service)
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
assert the guarded write refuses.

## 8. Checklist for a new module

1. Model the data in `prisma/schema.prisma`; encode value sets / signs as
   CHECKs in the migration; `migrate` + `generate`.
2. Write `<name>.repo.ts` and the schema register function(s); call them in
   `schema.ts`. Stop here if the module has no decisions.
3. When the first decision appears: put the rules in a pure core file — total
   functions, named predicates, plans that carry their assumptions,
   `DomainError`s for violations, parse functions for DB values.
4. Write `<name>.service.ts` (read → decide → execute inside
   `db.rw.$transaction`) and register it in `createServices()`. Switch the
   module's mutations to service-first + re-fetch.
5. Add the module's tests under `src/tests/modules/<name>/`: example tests,
   property tests for the core's laws (generators in `<name>.arbitraries.ts`),
   an integration test for the shell including the lost-race path, and a
   model-based test if the shell is stateful. Update the SDL snapshot.
