import { builder } from './builder.js';

/**
 * Minimal placeholder schema.
 *
 * The Prisma schema has no models yet, so there are no Prisma-backed GraphQL
 * types. This `health` query exists only so the schema is valid and the server
 * boots. Replace or extend it once you add Prisma models and expose them with
 * `builder.prismaObject(...)`.
 */
builder.queryType({
  fields: (t) => ({
    health: t.string({
      description: 'Liveness probe — always returns "ok".',
      resolve: () => 'ok',
    }),
  }),
});

export const schema = builder.toSchema();
