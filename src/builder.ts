import SchemaBuilder from '@pothos/core';
import PrismaPlugin from '@pothos/plugin-prisma';
import type { Context } from './context.js';
import type PrismaTypes from './generated/pothos-types.js';
import { getDatamodel } from './generated/pothos-types.js';

/**
 * Pothos schema builder.
 *
 * This module intentionally imports NO feature modules — only the `Context`
 * *type*. Feature modules import the builder, so importing them here would
 * create a cycle. The Prisma client is pulled from the request context
 * (`client: (ctx) => ctx.prisma`) rather than a module-level singleton, which
 * decouples the builder from how the client is constructed (see app.ts).
 */
export const builder = new SchemaBuilder<{
  Context: Context;
  PrismaTypes: PrismaTypes;
}>({
  plugins: [PrismaPlugin],
  prisma: {
    client: (ctx) => ctx.prisma,
    // Prisma 7 no longer attaches the datamodel to the client, so Pothos reads
    // it from its own generator output (src/generated/pothos-types.ts).
    dmmf: getDatamodel(),
  },
});

// Establish the root Query/Mutation types here (rather than in schema.ts) so
// they exist before any feature module's body runs: modules import this file,
// so this module is fully evaluated before they call `builder.queryField(...)`
// / `builder.mutationField(...)`.
builder.queryType({
  fields: (t) => ({
    health: t.string({
      description: 'Liveness probe — always returns "ok".',
      resolve: () => 'ok',
    }),
  }),
});

builder.mutationType({});
