# ts-graphql-reference

A minimal, type-safe GraphQL server reference:

| Layer        | Library                                        |
| ------------ | ---------------------------------------------- |
| Language     | TypeScript (ESM, `NodeNext`)                   |
| HTTP server  | [Fastify](https://fastify.dev)                 |
| GraphQL      | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) |
| Schema       | [Pothos](https://pothos-graphql.dev) (code-first) + Prisma plugin |
| ORM / DB     | [Prisma 7](https://www.prisma.io) + SQLite (via the better-sqlite3 driver adapter) |

The Prisma schema intentionally has **no models yet** — the full stack is wired
and verified to boot on an empty schema, ready for you to add your domain.

## Requirements

- Node.js ≥ 22 (uses `process.loadEnvFile`)
- pnpm (pinned via `packageManager`)

## Setup

```bash
pnpm install
pnpm prisma generate   # generates the Prisma client + Pothos types
cp .env.example .env    # already present; adjust if needed
pnpm dev
```

Open http://localhost:4000/graphql for GraphiQL and run:

```graphql
{
  health
}
```

## Scripts

| Script                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `pnpm dev`             | Run with hot reload (`tsx watch`)               |
| `pnpm build`           | Type-check + compile to `dist/` (`tsc`)         |
| `pnpm start`           | Run the compiled server (`node dist/server.js`) |
| `pnpm typecheck`       | `tsc --noEmit`                                  |
| `pnpm prisma:generate` | Regenerate the Prisma client + Pothos types     |
| `pnpm prisma:migrate`  | Create/apply a dev migration (`migrate dev`)    |
| `pnpm prisma:studio`   | Open Prisma Studio                              |

## Project layout

```
prisma/
  schema.prisma      # datasource (sqlite) + client & pothos generators; no models yet
prisma.config.ts     # Prisma 7 CLI config — schema path, migrations dir, DATABASE_URL
src/
  env.ts             # loads .env (Prisma 7 / Node no longer auto-load it)
  builder.ts         # PrismaClient (better-sqlite3 adapter) + Pothos SchemaBuilder
  schema.ts          # GraphQL schema; placeholder `health` query
  server.ts          # Fastify + Yoga wiring (entrypoint)
.env                 # DATABASE_URL, PORT
```

## Adding your first model

1. Add a model to `prisma/schema.prisma`:

   ```prisma
   model User {
     id    Int    @id @default(autoincrement())
     email String @unique
     name  String?
   }
   ```

2. Create the table and regenerate:

   ```bash
   pnpm prisma:migrate   # creates prisma/dev.db + a migration
   pnpm prisma:generate
   ```

3. Expose it in `src/` with the Pothos Prisma plugin:

   ```ts
   builder.prismaObject('User', {
     fields: (t) => ({
       id: t.exposeID('id'),
       email: t.exposeString('email'),
       name: t.exposeString('name', { nullable: true }),
     }),
   });

   builder.queryField('users', (t) =>
     t.prismaField({
       type: ['User'],
       resolve: (query, _root, _args, ctx) => ctx.prisma.user.findMany({ ...query }),
     }),
   );
   ```

## Notes on version-specific choices

- **`graphql` is pinned to `^16`.** GraphQL Yoga 5 and `@pothos/plugin-prisma` 4
  do not yet support `graphql@17`, and mixing graphql versions breaks at runtime.
- **Prisma 7 requires a driver adapter.** `datasource.url` is no longer read from
  `schema.prisma`; the connection lives in `.env` → `prisma.config.ts` (CLI) and
  the `PrismaBetterSqlite3` adapter (runtime, in `src/builder.ts`). To switch
  databases, swap the adapter (e.g. `@prisma/adapter-pg`) and the datasource
  provider.
- **`dmmf: Prisma.dmmf`** is passed to the Pothos Prisma plugin because Prisma 7
  no longer attaches the datamodel to the client instance.
- The Prisma client uses the classic `prisma-client-js` generator (imports from
  `@prisma/client`) and Pothos uses its default generated-types location
  (`@pothos/plugin-prisma/generated`). Prisma 7's newer `prisma-client` generator
  is also available if you prefer a custom output path.
