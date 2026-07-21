import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';

const MIGRATIONS_DIR = 'prisma/migrations';

/** All committed migrations' SQL, concatenated in chronological (folder) order. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d/.test(name))
    .toSorted()
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'))
    .join('\n');
}

const SCHEMA_DDL = migrationSql();

/**
 * A PrismaClient backed by a fresh in-process PGlite (WASM Postgres) with the
 * committed migrations applied. Same dialect as production Postgres, but with no
 * server and no Docker — and isolated per call, so each test file gets its own
 * throwaway database. Requires `prisma generate` (provider = postgresql) first.
 *
 * `onQuery` (optional) receives every SQL statement the client emits, so a test
 * can assert on query COUNT — the seam behind the no-N+1 law in
 * e2e/query-batching.test.ts.
 */
export async function makeTestPrisma(
  opts: { onQuery?: (sql: string) => void } = {},
): Promise<PrismaClient> {
  const pglite = new PGlite();
  await pglite.exec(SCHEMA_DDL);
  const { onQuery } = opts;
  if (!onQuery) return new PrismaClient({ adapter: new PrismaPGlite(pglite) });

  const client = new PrismaClient({
    adapter: new PrismaPGlite(pglite),
    log: [{ emit: 'event', level: 'query' }],
  });
  client.$on('query', (event) => onQuery(event.query));
  return client;
}

/**
 * Truncates every table between tests. The table list comes from the database
 * itself (pg_tables), so a new model is covered automatically — no manual,
 * FK-ordered delete list to forget to update. RESTART IDENTITY also resets the
 * sequences, keeping ids deterministic across tests.
 */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
