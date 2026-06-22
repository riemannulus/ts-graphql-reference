# ts-graphql-reference

A type-safe, modular GraphQL server reference.

| Layer        | Library                                                              |
| ------------ | ------------------------------------------------------------------- |
| Language     | TypeScript (ESM, `NodeNext`)                                        |
| HTTP server  | [Fastify](https://fastify.dev)                                      |
| GraphQL      | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)           |
| Schema       | [Pothos](https://pothos-graphql.dev) (code-first) + Prisma plugin   |
| ORM / DB     | [Prisma 7](https://www.prisma.io) + PostgreSQL (`@prisma/adapter-pg` driver adapter) |
| Tests        | [Vitest](https://vitest.dev) + fast-check (PBT) on in-process Postgres ([PGlite](https://pglite.dev)) |

The schema is built code-first with Pothos, every model is exposed through the
Pothos **Prisma plugin** (efficient relation loading), and all dependencies
(the Prisma client and the service layer) are **injected through the GraphQL
context** — resolvers never construct their own dependencies.

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

> Tests need no database of their own — they run on in-process PGlite (see
> [Testing](#testing)). The Postgres above is only for the dev server.

Example operations (GraphiQL at `/graphql`):

```graphql
mutation {
  createUser(input: { email: "alice@example.com", name: "Alice" }) { id status }
}

mutation {
  createPost(input: { title: "Hello", content: "world", authorId: 1 }) { id }
}

query {
  users { email status posts { title published } }   # relation via Pothos Prisma plugin
}

mutation {
  changeUserStatus(id: 1, status: SUSPENDED) { status }   # validated by the state machine
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
  app.ts             # composition root: creates PrismaClient + services,
                     #   injects them into the context, assembles Fastify + Yoga
  context.ts         # Context type + createContextFactory(deps) — the one place
                     #   dependencies enter the GraphQL layer
  builder.ts         # Pothos builder (plugins). Imports NO feature modules, so
                     #   modules can import it without a cycle. Pulls the client
                     #   from context: `client: (ctx) => ctx.prisma`.
  schema.ts          # aggregates module schema files → builder.toSchema()
  prisma.ts          # createPrismaClient(url) — PrismaClient on the
                     #   @prisma/adapter-pg (Postgres) driver adapter
  errors.ts          # DomainError base class (client-safe business errors)
  env.ts             # loads .env (Prisma 7 / Node no longer auto-load it)
  generated/         # Pothos types (git-ignored; `prisma generate`)
  modules/
    user/
      user.schema.ts   # shell: Pothos type + queries + mutations
      user.service.ts  # shell: business logic (PrismaClient injected)
      user.state.ts    # pure core: status state machine + invariants
      user.value.ts    # pure core: Email value object (parse, don't validate)
    post/
      schemas/
        post.type.ts     # Pothos prismaObject + relations
        post.query.ts    # query fields
        post.mutation.ts  # mutation fields
      post.service.ts
    auth/                # REST-only module: a Google OAuth callback (no Pothos schema)
      oauth.value.ts     # pure core: parse the callback query (parse, don't validate)
      oauth.provider.ts  # shell: GoogleOAuthClient port + an unimplemented stub
      oauth.service.ts   # shell: provisions a user (via UserService) from the profile
      oauth.route.ts     # shell: registerGoogleOAuth(app, svc) — GET /google/oauth[/callback]
  tests/
    support/            # shared infra: helpers (in-process PGlite + resetDb)
    modules/<name>/     # tests mirror src/modules/<name>/ — unit + property +
                        #   integration + model-based (by filename suffix), plus
                        #   <name>.arbitraries.ts (this module's fast-check generators)
    integrations/       # cross-module: several services + DB, no transport
    e2e/                # whole-app tests through app.inject (cross-module)
```

> Conventions for invariant-driven, PBT-friendly code (functional core /
> imperative shell, value objects, property laws) are documented in
> [CONVENTIONS.md](./CONVENTIONS.md).

### Dependency injection / request flow

1. `buildApp()` (composition root) creates the `PrismaClient` and the service
   container **once**, then builds the context factory with them.
2. Per request, Yoga calls the factory, which returns
   `{ prisma, services, req, reply }` as the resolver `Context`.
3. Resolvers call `ctx.services.user.*` / `ctx.services.post.*`. The Pothos
   Prisma plugin reads the client via `client: (ctx) => ctx.prisma`.

This keeps `builder.ts` free of feature-module imports (no cycles), keeps
business logic in services (testable without GraphQL), and makes it trivial to
swap dependencies in tests — `buildApp({ prisma: testClient })`.

### Service ↔ Pothos Prisma plugin

`t.prismaField` resolvers receive a `query` object (the selected
relations/fields). Service read methods accept and spread it
(`findMany({ ...query, ... })`), so the plugin's relation-loading optimization
is preserved even though queries flow through the service layer.

### Non-GraphQL endpoints (the OAuth callback)

Not every entry point is GraphQL. `src/modules/auth/` is a worked example of a
plain HTTP surface — a Google OAuth login callback at `GET /google/oauth` and
`GET /google/oauth/callback` — that still provisions a user through the **same
`UserService`** the `createUser` mutation uses (`OAuthService.completeLogin` →
`users.findOrCreateByEmail`). The provider HTTP itself (exchanging the code,
fetching the profile) is left unimplemented behind a `GoogleOAuthClient` port;
everything around it is complete and tested.

The point of interest is how dependencies reach the route **without the GraphQL
context leaking into it**:

- The GraphQL per-request `Context` (`{ prisma, services, req, reply }`) is built
  by Yoga's context factory and exists *only inside resolvers*.
- The REST route gets its dependency at **registration time** —
  `registerGoogleOAuth(app, services.auth)` closes over exactly one service from
  the container built once in the composition root. Per request it reads only
  `req.query`; it never sees the `PrismaClient` or a shared mutable context.
- Both surfaces draw from the **same `services` container** (composed in
  `createServices`, where `OAuthService` is wired to `UserService`), but neither
  leaks its request context into the other. Narrowest dependency, no spread.

`OAuthService` depends on a `GoogleOAuthClient` *interface*, so production binds
an unimplemented stub while tests inject a fake — which is how the callback is
exercised end-to-end (`buildApp({ googleOAuth })`) with no real network.

### Error handling

Services throw framework-agnostic `DomainError`s for expected business-rule
violations (e.g. an illegal status transition). Yoga's `maskError` (in app.ts)
turns those into client-visible GraphQL errors carrying a `code`; any other
(unexpected) error is masked as a generic internal error.

## Adding a module

The `user` and `post` modules show two layouts (single schema file vs a
`schemas/` split). To add another — e.g. **payment** or **point**:

1. Add the model(s) to `prisma/schema.prisma`, then
   `pnpm prisma migrate dev && pnpm prisma generate`.
2. Create `modules/<name>/<name>.service.ts` (business logic, PrismaClient via
   constructor) and add it to `createServices()` in `context.ts` — the
   `Services` context type is `ReturnType<typeof createServices>`, so it updates
   automatically (one edit, not two).
3. Add `modules/<name>/<name>.schema.ts` (or a `schemas/` split) with
   `builder.prismaObject(...)` / `builder.queryField(...)` /
   `builder.mutationField(...)`, and import it in `src/schema.ts`.
4. For non-GraphQL surfaces (e.g. an **OAuth callback** or a **payment
   webhook**), add a `registerXxx(app, service)` to the module and call it in
   `buildApp()`, handing it just the one service it needs — see
   `src/modules/auth/oauth.route.ts` and the "Non-GraphQL endpoints" section
   above. Sub-features can be nested (e.g. `point/charge`, `point/refund`).

State-machine-style invariants belong in a `<name>.state.ts` module (see
`user.state.ts`), kept separate from persistence and the schema.

## Testing

```bash
pnpm test
```

Tests run against **real Postgres with zero setup**: `makeTestPrisma()`
(`tests/support/helpers.ts`) starts an in-process [PGlite](https://pglite.dev)
(WASM Postgres) database, applies the committed migrations, and returns a Prisma
client on it — no Docker, no server, and a fresh isolated database per test file.
That client is provider-identical to production (`@prisma/adapter-pg`), so
dialect bugs surface in tests rather than in prod. Tests are organized by module
— `tests/modules/<name>/` mirrors `src/modules/<name>/`, with the test layer
encoded in the filename suffix. Cross-module tests live outside the module
folders: `tests/integrations/` (several services + DB, no transport) and
`tests/e2e/` (through GraphQL).

- **`modules/user/user.state.test.ts`** — example-based unit tests of the transition rules.
- **`modules/user/user.service.test.ts`** — user service logic against the test DB.
- **`modules/post/post.service.test.ts`** — post CRUD, publish idempotence, and the
  `onlyPublished` filter against the test DB. (`post` has no pure core — no domain
  invariants — so it is covered at the service level.)
- **`modules/auth/oauth.value.test.ts`** — `parseOAuthCallback` boundary parsing:
  valid callbacks, missing/non-string params, and a provider `error` param.
- **`modules/auth/oauth.service.test.ts`** — `OAuthService.completeLogin` with a fake
  provider + the test DB: creates a user from the profile, idempotent on repeat login.
- **`integrations/user-post.test.ts`** — user and post services together: create a
  user, author a post, and assert the relation persists both ways (and the FK is enforced).
- **`e2e/graphql.test.ts`** — end-to-end through Fastify via `app.inject`,
  including the relation query and the domain-error mapping.
- **`e2e/oauth.test.ts`** — the non-GraphQL OAuth callback through `app.inject`: the
  request provisions a user via the user module, repeat callbacks are idempotent, a
  missing param maps to a 400 domain error, and `/google/oauth` redirects (302).

Property-based tests (`@fast-check/vitest`, suffix `.prop.test.ts` / `.model.test.ts`)
sit beside them and assert **laws** rather than examples:

- **`user.state.prop.test.ts`** — totality, terminal state, and agreement with
  `canTransition`.
- **`user.value.prop.test.ts`** — parse/normalization laws for the `Email` value object.
- **`user.service.model.test.ts`** — model-based: random status-change sequences
  stay consistent between the state-machine model and the real service + DB.
- **`post.service.prop.test.ts`** — persistence laws: `create` round-trips
  title/content and starts unpublished; `onlyPublished` returns exactly the
  published subset for an arbitrary seed.
- **`oauth.value.prop.test.ts`** — totality: `parseOAuthCallback` either returns a
  complete callback or throws `OAuthError` (never anything else), and a provider
  `error` always rejects regardless of the code/state.

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
- **Pothos gets the datamodel from its generator.** Prisma 7 no longer attaches
  the datamodel to the client, so the Pothos generator emits a `.ts` file with a
  runtime `getDatamodel()` (`src/generated/pothos-types.ts`), passed as
  `dmmf: getDatamodel()` in `builder.ts`.
