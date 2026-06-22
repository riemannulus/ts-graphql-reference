import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/app';

/**
 * Creates a PrismaClient backed by the Prisma 7 Postgres driver adapter
 * (`@prisma/adapter-pg`). Prisma 7 requires a driver adapter, and the connection
 * URL is supplied here (from `DATABASE_URL`) rather than in `schema.prisma`.
 *
 * Tests run against the same Postgres dialect via an in-process PGlite client
 * (see `src/tests/support/helpers.ts`), so this stays Postgres-only.
 */
export function createPrismaClient(
  databaseUrl: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
