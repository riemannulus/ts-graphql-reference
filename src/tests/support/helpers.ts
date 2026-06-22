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
 */
export async function makeTestPrisma(): Promise<PrismaClient> {
  const pglite = new PGlite();
  await pglite.exec(SCHEMA_DDL);
  return new PrismaClient({ adapter: new PrismaPGlite(pglite) });
}

/** Truncates all tables between tests. Posts first due to the FK to User. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.post.deleteMany();
  await prisma.user.deleteMany();
}
