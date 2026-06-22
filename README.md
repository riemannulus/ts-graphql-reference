# ts-graphql-reference

A type-safe, modular GraphQL server reference.

| Layer        | Library                                                              |
| ------------ | ------------------------------------------------------------------- |
| Language     | TypeScript (ESM, `NodeNext`)                                        |
| HTTP server  | [Fastify](https://fastify.dev)                                      |
| GraphQL      | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)           |
| Schema       | [Pothos](https://pothos-graphql.dev) (code-first) + Prisma plugin   |
| ORM / DB     | [Prisma 7](https://www.prisma.io) + SQLite (better-sqlite3 adapter) |
| Tests        | [Vitest](https://vitest.dev)                                        |

The schema is built code-first with Pothos, every model is exposed through the
Pothos **Prisma plugin** (efficient relation loading), and all dependencies
(the Prisma client and the service layer) are **injected through the GraphQL
context** — resolvers never construct their own dependencies.

## Requirements

- Node.js ≥ 22 (uses `process.loadEnvFile`)
- pnpm (pinned via `packageManager`)

## Setup

```bash
pnpm install            # also runs `prisma generate` (postinstall)
pnpm prisma migrate dev # creates prisma/dev.db from the migrations
pnpm dev                # http://localhost:4000/graphql
```

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
  prisma.ts          # createPrismaClient(url) — better-sqlite3 driver adapter
  errors.ts          # DomainError base class (client-safe business errors)
  env.ts             # loads .env (Prisma 7 / Node no longer auto-load it)
  generated/         # Pothos types (git-ignored; `prisma generate`)
  modules/
    user/
      user.schema.ts   # Pothos type + queries + mutations
      user.service.ts  # business logic (PrismaClient injected)
      user.state.ts    # status state machine + invariants
    post/
      schemas/
        post.type.ts     # Pothos prismaObject + relations
        post.query.ts    # query fields
        post.mutation.ts  # mutation fields
      post.service.ts
  tests/             # Vitest: unit (state), service (DB), GraphQL (via app.inject)
```

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
4. For non-GraphQL surfaces (e.g. a **payment webhook**), register a Fastify
   route in `app.ts` that calls the service — see the commented hook in
   `buildApp()`. Sub-features can be nested (e.g. `point/charge`, `point/refund`).

State-machine-style invariants belong in a `<name>.state.ts` module (see
`user.state.ts`), kept separate from persistence and the schema.

## Testing

```bash
pnpm test
```

A Vitest `globalSetup` applies the committed migrations to a throwaway
`prisma/test.db` (an explicit `DATABASE_URL` overrides `.env`). The suite covers:

- **`user.state.test.ts`** — pure unit tests of the transition rules.
- **`user.service.test.ts`** — service logic against the test DB.
- **`graphql.test.ts`** — end-to-end through Fastify via `app.inject`, including
  the relation query and the domain-error mapping.

## Notes on version-specific choices

- **`graphql` is pinned to `^16`.** GraphQL Yoga 5 and `@pothos/plugin-prisma` 4
  don't yet support `graphql@17`, and mixing versions breaks at runtime.
- **Prisma 7 requires a driver adapter.** `datasource.url` is no longer read
  from `schema.prisma`; the connection lives in `.env` → `prisma.config.ts`
  (CLI) and the `PrismaBetterSqlite3` adapter (runtime). Swap the adapter (e.g.
  `@prisma/adapter-pg`) and the datasource provider to change databases.
- **Pothos gets the datamodel from its generator.** Prisma 7 no longer attaches
  the datamodel to the client, so the Pothos generator emits a `.ts` file with a
  runtime `getDatamodel()` (`src/generated/pothos-types.ts`), passed as
  `dmmf: getDatamodel()` in `builder.ts`.
