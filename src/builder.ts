import SchemaBuilder from '@pothos/core';
import PrismaPlugin from '@pothos/plugin-prisma';
import type PrismaTypes from '@pothos/plugin-prisma/generated';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { Prisma, PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';

/**
 * Prisma 7 requires a driver adapter to connect to the database. For SQLite we
 * use the better-sqlite3 adapter; swap this for `@prisma/adapter-pg` etc. when
 * moving to another database.
 */
const adapter = new PrismaBetterSqlite3({ url: databaseUrl });

/**
 * Single shared Prisma client. Imported by the server for graceful shutdown
 * and injected into the GraphQL context so resolvers can run queries.
 */
export const prisma = new PrismaClient({ adapter });

export interface Context {
  prisma: PrismaClient;
}

/**
 * Pothos schema builder, wired with the Prisma plugin.
 *
 * Once you add a model to `prisma/schema.prisma` and run `pnpm prisma generate`,
 * expose it with `builder.prismaObject('ModelName', { ... })` and add fields to
 * the query/mutation types.
 */
export const builder = new SchemaBuilder<{
  Context: Context;
  PrismaTypes: PrismaTypes;
}>({
  plugins: [PrismaPlugin],
  prisma: {
    client: prisma,
    // Pothos needs the datamodel to plan relation queries. Prisma 7 no longer
    // attaches it to the client instance, so pass it explicitly.
    dmmf: Prisma.dmmf,
  },
});
