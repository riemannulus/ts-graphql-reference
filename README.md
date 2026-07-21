# ts-graphql-reference

A type-safe, modular GraphQL server reference.

| Layer        | Library                                                              |
| ------------ | -------------------------------------------------------------------- |
| Language     | TypeScript (ESM, `NodeNext`)                                        |
| HTTP server  | [Fastify](https://fastify.dev)                                      |
| GraphQL      | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)           |
| Schema       | [Pothos](https://pothos-graphql.dev) (code-first) + Prisma plugin   |
| ORM / DB     | [Prisma 7](https://www.prisma.io) + PostgreSQL (`@prisma/adapter-pg` driver adapter), primary + optional read replica |
| Tests        | [Vitest](https://vitest.dev) + fast-check (PBT) on in-process Postgres ([PGlite](https://pglite.dev)) |

The schema is built code-first with Pothos, every model is exposed through the
Pothos **Prisma plugin** (efficient relation loading), and each feature module
is split into explicit layers — a pure **core** that decides, a **repo** that
talks to the database, a **service** that assembles use-cases, and a **schema**
file that exposes them — wired together once in the composition root and
injected through the GraphQL context.

## Requirements

- Node.js ≥ 22 (uses `process.loadEnvFile`)
- pnpm (pinned via `packageManager`)

## Setup

```bash
# A local Postgres for development (matches the default DATABASE_URL in .env):
docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine

pnpm install            # also runs `prisma generate` (postinstall)
pnpm prisma migrate dev # applies the migrations to DATABASE_URL
pnpm dev                # http://localhost:4000/graphql
```

Environment:

- `DATABASE_URL` — the primary (read-write) Postgres.
- `READONLY_DATABASE_URL` — optional read replica. When unset, reads route to
  the primary; the routing rules stay identical either way (see
  [RWDB / RODB routing](#rwdb--rodb-routing)).

> Tests need no database of their own — they run on in-process PGlite (see
> [Testing](#testing)). The Postgres above is only for the dev server.

Example operations (GraphiQL at `/graphql`):

```graphql
mutation {
  signUp(input: { email: "alice@example.com", name: "Alice" }) { id status posts { title } }
}

mutation {
  chargePoint(input: { userId: 1, paidAmount: 100, freeAmount: 30 }) { id state }
}

mutation {
  spendPoint(input: { userId: 1, amount: 120, reason: "checkout" }) { paidAmount freeAmount }
}

mutation {
  transferPoint(input: { fromUserId: 1, toUserId: 2, amount: 50 }) { paidAmount totalAmount }
}

query {
  users { email status pointBalance { totalAmount } posts { title } }
}
```

## Scripts

| Script                 | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `pnpm dev`             | Hot-reloading dev server (`tsx watch`)            |
| `pnpm build`           | Compile to `dist/` (`tsconfig.build.json`, no tests) |
| `pnpm start`           | Run the compiled server                           |
| `pnpm typecheck`       | `tsc --noEmit` (includes tests)                   |
| `pnpm lint`            | Lint with oxlint (`lint:fix` to auto-fix)         |
| `pnpm test`            | Run the Vitest suite                              |
| `pnpm test:watch`      | Vitest in watch mode                              |
| `pnpm prisma:generate` | Regenerate the Prisma client + Pothos types       |
| `pnpm prisma:migrate`  | Create/apply a dev migration                      |
| `pnpm prisma:studio`   | Open Prisma Studio                                |

## Architecture

```
src/
  server.ts          # process entrypoint: loads .env, buildApp(), listen()
  app.ts             # composition root: creates the Db handles + services,
                     #   injects them into the context, assembles Fastify + Yoga
  services.ts        # createServices(): the service container (domain use-cases
                     #   + cross-service wiring) — transport-agnostic
  db/                    # persistence + concurrency
    prisma.ts            # createPrismaClient(url) — PrismaClient on the
                         #   @prisma/adapter-pg (Postgres) driver adapter
    db.ts                # Db = { rw, ro } PrismaClients + DbClient (what repos take)
    prisma-errors.ts     # pure Prisma error-code predicates (P2002 / P2025 / P2034)
    uow.ts               # unit of work: run / snapshot / serialized / trySerialized
                         #   — the concurrency ladder, the only way to open a tx
    locks.ts             # pure advisory-lock machinery: LockKey + defineLocks +
                         #   orderLocks (global order); acquire SQL lives in uow.ts
    lock-registry.ts     # the one place that says WHAT is lockable (lockKey);
                         #   add an entity here — the machinery in locks.ts is fixed
  flags/                 # feature flags (OpenFeature) — the read facade, mirrors db/locks
    flags.ts             # pure machinery: the gate spec + defineFlags + FlagReader type
    flag-registry.ts     # the one place that says WHAT is flag-gated (FLAGS);
                         #   add a flag here — the machinery in flags.ts is fixed
    flag-reader.ts       # binds FLAGS to the OpenFeature client per request
                         #   (memoized); the uow.ts-style I/O shell over the machinery
  graphql/               # GraphQL layer assembly
    builder.ts           # Pothos builder (plugins). Imports NO feature modules, so
                         #   modules can import it without a cycle. Pulls the client
                         #   from context: `client: (ctx) => ctx.db`.
    schema.ts            # calls each module's registerXxxModule() → builder.toSchema()
    context.ts           # Context type + createContextFactory() + the
                         #   per-operation rw/ro read-client routing
  foundation/            # cross-cutting primitives (no I/O, no framework)
    errors.ts            # DomainError base class (client-safe business errors)
    env.ts               # loads .env (Prisma 7 / Node no longer auto-load it)
  generated/             # Pothos types (git-ignored; `prisma generate`)
  modules/
    point/             # the LAYERED module blueprint (has real decisions)
      point.core.ts    # pure: planSpend/planCharge — every business branch
      point.write.repo.ts # Prisma writes: use-case executors (loadSpendWorld/apply*Plan)
      point.read.repo.ts  # Prisma reads: GraphQL projections (find*/get*ById)
      point.service.ts # use-cases: read → decide → execute, in one rw tx
      schemas/
        index.ts           # registerPointModule(): the module's one entry point
        point.type.ts      # Pothos objects (registerPointTypes)
        point.query.ts     # query fields → repo reads on ctx.db
        point.mutation.ts  # mutations → service, then re-fetch with `query`
    user/
      user.state.ts    # pure core: status state machine + invariants
      user.value.ts    # pure core: Email value object (parse, don't validate)
      user.repo.ts     # Prisma: projections + the CAS status write
      user.service.ts  # use-cases (create / findOrCreateByEmail / changeStatus)
      schemas/           # GraphQL delivery (split like point/)
        user.type.ts     #   User object + the shared UserStatus enum ref
        user.query.ts    #   user / users
        user.mutation.ts #   changeUserStatus
    post/              # a module with NO decisions: repo + schema only
      post.repo.ts       # + findByIds: order-preserving hydration for search
      schemas/
    search/            # external-key pattern: index gives ids, DB hydrates them
      post-search.provider.ts  # port: PostSearchIndex (+ unimplemented stub)
      post-search.service.ts   # thin — holds the port (no decision → no core)
      schemas/
        post-search.query.ts   # searchPosts: hits is its own prismaField
    auth/              # a module delivered over HTTP, not GraphQL (no schema)
      oauth.value.ts     # pure core: parse the callback query
      oauth.provider.ts  # port: GoogleOAuthClient (function record) + stub
      oauth.service.ts   # use-case: provisions a user via the user service
      routes/            # HTTP delivery layer (the peer of schemas/)
        oauth.route.ts   # registerGoogleOAuth(app, svc)
    feature-flag/      # the crepe flag store, adapted to OpenFeature (no schema —
      feature-flag.core.ts     #   pure: STAGES + parseStage + isActive (the crepe rule)
      feature-flag.repo.ts     #   Prisma: live-row lookup + admin writes
      feature-flag.service.ts  #   admin use-cases (upsert / soft-delete)
      feature-flag.provider.ts #   the DB-backed OpenFeature Provider (the adapter)
    onboarding/        # cross-module use-case (one tx across user + post)
      onboarding.content.ts
      onboarding.service.ts
      schemas/
  tests/
    support/            # shared infra: helpers (in-process PGlite + resetDb)
    modules/<name>/     # tests mirror src/modules/<name>/ — unit + property +
                        #   integration + model-based (by filename suffix), plus
                        #   <name>.arbitraries.ts (this module's generators)
    integrations/       # cross-module: services/repos + DB, no transport
    e2e/                # whole-app tests through app.inject (incl. the schema
                        #   snapshot and the rw/ro routing proof)
```

> Layer rules, the plan pattern, and the module "graduation rule" are
> documented in [CONVENTIONS.md](./CONVENTIONS.md) — and enforced by oxlint
> `no-restricted-imports` per layer, so they are not just guidelines.

### The layers in one request

**Query path** (`users { ... }`): the resolver calls a repo read function on
`ctx.db` — the single routed client, whose `ReadDbClient` type carries no write
methods — spreading the Pothos `query` object so relations load optimally. No
service in between: plain reads are projections and carry no decisions.

**Mutation path** (`spendPoint(...)`): the resolver calls a use-case, which is
the three-line assembly

```ts
const world = await pointRepo.loadSpendWorld(tx, userId);            // read   (repo)
const plan  = planSpend(world.snapshot, world.charges, input.amount); // decide (core, pure)
return pointRepo.applySpendPlan(tx, userId, input.reason, plan);      // execute (repo)
```

inside one `REPEATABLE READ` transaction on the primary (one snapshot for the
whole decision — under `READ COMMITTED`, the two reads could straddle a
concurrent commit and a healthy ledger would look corrupt). The core returns a
**plan** — pure data describing every write, including the values each UPDATE
must still see. The repo executes it mechanically; the plan's assumptions
become optimistic-concurrency guards, and both a missed guard and a
serialization failure surface as a retryable `CONFLICT` instead of a
double-spend. The resolver then **re-fetches** the result by id with the
Pothos `query`, so the client's selection set is served without the use-case
ever learning about GraphQL.

Every transaction opens through **`uow`** (`src/db/uow.ts`), the concurrency
ladder — `run` (a plain atomic tx), `snapshot` (REPEATABLE READ, used by
`spend`), and `serialized` (advisory-locked, used by `transferPoint` to move
points between two users under a deadlock-free two-key lock). Pick the weakest
rung that holds the invariant; all of them surface a lost race as the same
retryable `CONFLICT`. See CONVENTIONS "The concurrency ladder".

### RWDB / RODB routing

`db.ts` exposes `Db = { rw, ro }`: the primary and an optional read replica
(the same client when `READONLY_DATABASE_URL` is unset). Three rules, each
enforced by construction rather than convention where possible:

1. **The one client (`ctx.db`) is routed per operation.** The context factory
   classifies the operation type: queries get `ro`, mutations get `rw`
   (`routeClient` in context.ts). Because mutations resolve their selection sets
   on `rw`, the post-write re-fetch — and every `t.relation` under it —
   reads-its-own-writes even with a lagging replica. Its `ReadDbClient` type has
   no write methods, so a resolver cannot write through `ctx.db` — by type, not
   convention, and uniformly for queries and mutations (there is no second
   handle to reach for). A tier-1 direct write widens it through `writer(ctx)`,
   the one runtime-guarded escape hatch (throws outside a mutation), which yields
   a `DbClient` typed without `$transaction`.
2. **Use-cases never touch `ro`.** A decision must be made on the state it
   will write against; services receive the full `Db` but use `db.rw` only.
3. **Repos never choose.** Every repo function takes the client as its first
   parameter — `ReadDbClient` for reads (rw, ro, and tx handles all satisfy
   it), `DbClient` for writes — so where a statement runs is always the
   caller's decision.

The e2e test `db-routing.test.ts` proves the routing by giving the app two
*different* databases and observing which one each operation touches.

### Dependency injection / request flow

1. `buildApp()` (composition root) creates the `Db` handles and the service
   container **once**, then builds the context factory with them.
2. Per request, Yoga calls the factory, which returns
   `{ db (routed), operation, services, req, reply }` as the resolver `Context`.
3. Resolvers call `ctx.services.*` for use-cases and repo read functions (with
   `ctx.db`) for projections.

Services are factory functions (`createUserService(db)`) returning records of
closures — no classes, no DI container. Ports (the Google OAuth client) are
typed function records with an unimplemented production stub; tests inject
object-literal fakes (`buildApp({ prisma, googleOAuth: fake })`).

### Non-GraphQL endpoints (the OAuth callback)

Not every entry point is GraphQL. `src/modules/auth/` is a worked example of a
plain HTTP surface — a Google OAuth login callback at `GET /google/oauth` and
`GET /google/oauth/callback` — that provisions a user through the **user
module**: the user service, and through it the same `parseEmail` boundary and
repo write the GraphQL sign-up path uses. The REST route gets its dependency at
**registration time** — `registerGoogleOAuth(app, services.auth)` closes over
exactly one service from the container built in the composition root; it never
sees the `Db` handles or the GraphQL per-request context. The provider HTTP
itself is left unimplemented behind the `GoogleOAuthClient` port; everything
around it is complete and tested end-to-end with a fake.

### Feature flags (OpenFeature)

Feature switches go through [OpenFeature](https://openfeature.dev): the code depends
on the vendor-neutral SDK, and a **provider** plugs in behind it — so swapping the
backend (flagd, Unleash, LaunchDarkly) later is a provider change with no call-site
edits. The reference ships one provider, `DbFeatureFlagProvider`
(`modules/feature-flag/`), which adapts the **crepe** flag model: a flag is active
only for the deploy `STAGE`, inside its `[enableAfter, disableAfter]` window, and
while not soft-deleted — safe-default **off** (a missing backend fails every gate
closed). Tests inject the SDK's `InMemoryProvider` instead (`buildApp({ flagProvider })`).

Reading mirrors the locks split (`db/locks.ts` + `db/lock-registry.ts`):

- `flags/flags.ts` — pure machinery (`defineFlags`, the `FlagReader` type).
- `flags/flag-registry.ts` — the one growing file: WHAT is flag-gated (`FLAGS`),
  each flag's default, and its JSDoc.
- `flags/flag-reader.ts` — binds the registry to the OpenFeature client per request
  (the `uow.ts`-style I/O shell); reads are memoized so a flag can't flip mid-request.

`ctx.flags` is the per-request reader, and the three flag-use modes each ship as a
one-line-in-the-service example (no `if`-sprawl):

- **gate / kill switch** — `point.transfer` calls `flags.assert.pointTransfer()`
  (throws `FeatureDisabledError` → client code `UNAVAILABLE` when off);
- **rule change** — the same transfer reads `flags.pointTransferPreferFree()` and
  passes the boolean into the pure core (`planSpend`), which owns the branch;
- **implementation swap** — `onboarding.register` reads `flags.welcomeVariant()` and
  the core selects the welcome-post builder from an exhaustive `Record<Variant, …>`.

Layers that must NOT read a flag — core, repo, schema — are lint-blocked from
importing the facade (a core receives a flag value as DATA); a service may import the
`FlagReader` *type* but not the SDK or the reader factory. Writing flags is the
module's admin service (`ctx.services.featureFlag`); a staff-gated delivery is a
future addition (gannet has no authorization layer yet).

### Error handling

Services and cores throw framework-agnostic `DomainError`s for expected
business-rule violations (an illegal transition, an insufficient balance, a
lost optimistic-concurrency race → `CONFLICT`). Yoga's `maskError` (app.ts)
turns those into client-visible GraphQL errors carrying a `code`; anything
else — including data-corruption errors like an out-of-set status, which the
code *parses* rather than silently coercing — is masked as a generic internal
error. DB CHECK constraints (status/state value sets, non-negative amounts)
back the same invariants on the write side.

## Adding a module

Follow the **graduation rule** — add layers when their first real content
appears, not before:

1. Model the data in `prisma/schema.prisma`, then
   `pnpm prisma migrate dev && pnpm prisma generate`. Encode value sets and
   sign constraints as CHECKs in the migration.
2. Start with `modules/<name>/<name>.repo.ts` (all Prisma for the module) and a
   schema file (or `schemas/` split) whose fields call the repo on
   `ctx.db` (tier-1 writes widen it through `writer(ctx)`). Compose the schema
   register functions into `registerXxxModule()` in `schemas/index.ts` and call
   that one function in `src/graphql/schema.ts`. **A module with no decisions
   stops here** (see `post/`).
3. The first real decision (a state machine, a computed plan, a cross-row
   rule) earns a pure `<name>.core.ts` (or `.state.ts`/`.value.ts`) and a
   `<name>.service.ts` whose methods assemble read → decide → execute inside a
   `uow.run` / `uow.snapshot` (the concurrency ladder). Register the service in
   `createServices()` (`services.ts`) — the `Services` type updates
   automatically. Mutations then go service-first and re-fetch with the Pothos
   `query` (see `point/`).
4. For non-GraphQL surfaces (an OAuth callback, a payment webhook), add a
   `routes/<name>.route.ts` (`registerXxx(app, service)`) — the HTTP peer of
   `schemas/` — and call it in `buildApp()` (see `auth/`). Modules group by
   domain, not transport: the route sits beside the same service the GraphQL
   fields use.
5. A use-case spanning modules composes the other modules' repo functions
   inside ONE transaction, with decisions still taken by each module's core
   (see `onboarding/`).

## Testing

```bash
pnpm test
```

Tests run against **real Postgres with zero setup**: `makeTestPrisma()`
(`tests/support/helpers.ts`) starts an in-process [PGlite](https://pglite.dev)
(WASM Postgres) database, applies the committed migrations, and returns a Prisma
client on it — no Docker, no server, and a fresh isolated database per test
file. `resetDb` truncates whatever tables the database reports (no manual
FK-ordered list to maintain). The client is dialect-identical to production —
both the test adapter (`pglite-prisma-adapter`) and the production one
(`@prisma/adapter-pg`) speak the `postgresql` provider — so dialect bugs
surface in tests rather than in prod.

The test *layer* is the filename suffix, the test *module* is the folder:

- **`modules/point/point.core.prop.test.ts`** — the payoff of the plan pattern:
  conservation, paid-first, FIFO, no-overspend, depletion, and totality laws
  run against hundreds of random ledgers with no database.
- **`modules/point/point.service.test.ts`** — the shell against the test DB,
  including the lost-race case: a stale plan's guards must roll the whole
  spend back (`CONFLICT`), writing nothing, and the `transfer` cases.
- **`modules/user/user.service.model.test.ts`**,
  **`modules/point/point.service.model.test.ts`** — model-based PBT: random
  operation sequences stay consistent between an in-memory spec and the real
  service + DB (user status machine; point ledger, where the balance must always
  equal the charge ledger it summarizes).
- **`integrations/concurrency.test.ts`** — the `uow` rungs against the DB: `run`
  commits/rolls back, `snapshot` really runs at REPEATABLE READ, `serialized`
  acquires the advisory locks (visible in `pg_locks`).
- **`integrations/locks.prop.test.ts`** — the global lock order (`orderLocks`)
  is sorted, deduplicated, and input-order-independent — the deadlock-freedom
  law — with no database.
- **`modules/user/user.state.prop.test.ts`**, **`user.value.prop.test.ts`**,
  **`modules/auth/oauth.value.prop.test.ts`** — core laws (totality, terminal
  state, agreement, normalization).
- **`integrations/schema-constraints.test.ts`** — the DB-side halves: CHECK
  constraints reject out-of-set statuses/states and negative amounts via raw
  SQL, with no application layer in the way.
- **`e2e/db-routing.test.ts`** — the rw/ro proof described above.
- **`e2e/schema-snapshot.test.ts`** — the assembled SDL as a snapshot, so a
  module dropped from schema.ts's register list fails loudly.
- **`e2e/graphql.test.ts`**, **`e2e/oauth.test.ts`** — whole-app flows through
  `app.inject`, including domain-error mapping and the point charge→spend flow.
- **`e2e/search.test.ts`** — the external-key pattern end to end: a fake index
  feeds ranked ids, the `hits` prismaField receives the nested selection, and
  the hits come back in rank order with their relations loaded.

## Notes on version-specific choices

- **`graphql` is pinned to `^16`.** GraphQL Yoga 5 and `@pothos/plugin-prisma` 4
  don't yet support `graphql@17`, and mixing versions breaks at runtime.
- **Prisma 7 requires a driver adapter.** `datasource.url` is no longer read
  from `schema.prisma`; the connection lives in `.env` → `prisma.config.ts`
  (CLI) and the `@prisma/adapter-pg` adapter (runtime, in `createPrismaClient`).
- **Tests use PGlite, not a database server.** The generated client is
  provider-locked to `postgresql`, and both `@prisma/adapter-pg` (production) and
  the [`pglite-prisma-adapter`](https://www.npmjs.com/package/pglite-prisma-adapter)
  (tests) report that provider — so one `prisma generate` serves both. PGlite is
  Postgres compiled to WASM, so tests get real Postgres dialect in-process with
  no Docker. The committed migrations are Postgres-dialect; tests apply them to a
  fresh PGlite instance, production applies them with `prisma migrate deploy`.
  PGlite is single-connection, so true concurrency (two racing transactions)
  cannot be exercised — which is why the optimistic guards are designed to be
  testable sequentially (decide on a snapshot, invalidate it, execute).
- **The PGlite adapter ignores the interactive-transaction `isolationLevel`
  option** that the production `@prisma/adapter-pg` honors, so `uow` raises
  isolation with a `SET TRANSACTION ISOLATION LEVEL` statement instead —
  identical, observable behavior on both adapters (`integrations/concurrency.test.ts`
  asserts `snapshot` is really at REPEATABLE READ).
- **Pothos gets the datamodel from its generator.** Prisma 7 no longer attaches
  the datamodel to the client, so the Pothos generator emits a `.ts` file with a
  runtime `getDatamodel()` (`src/generated/pothos-types.ts`), passed as
  `dmmf: getDatamodel()` in `builder.ts`.
- **The schema snapshot test round-trips through introspection** instead of
  calling `printSchema(schema)` directly: `graphql` is a dual CJS/ESM package,
  and printing a Pothos-built (CJS-realm) schema with the test file's ESM copy
  trips graphql's realm check.
