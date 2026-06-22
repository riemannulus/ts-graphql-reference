import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

/**
 * Creates a PrismaClient backed by the better-sqlite3 driver adapter.
 *
 * Prisma 7 requires a driver adapter; the connection URL is supplied here
 * (from `DATABASE_URL`) rather than in `schema.prisma`. Pass an explicit
 * `databaseUrl` to point at a different database — e.g. a throwaway test DB.
 */
export function createPrismaClient(
  databaseUrl: string = process.env.DATABASE_URL ?? 'file:./prisma/dev.db',
): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}
