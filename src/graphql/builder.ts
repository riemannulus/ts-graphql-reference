import { trace } from '@opentelemetry/api';
import SchemaBuilder from '@pothos/core';
import PrismaPlugin from '@pothos/plugin-prisma';
import TracingPlugin, { isRootField } from '@pothos/plugin-tracing';
import { createOpenTelemetryWrapper } from '@pothos/tracing-opentelemetry';
import type { PrismaClient } from '@prisma/client';
import type { Context } from './context.js';
import type PrismaTypes from '../generated/pothos-types.js';
import { getDatamodel } from '../generated/pothos-types.js';

// The resolver-span wrapper. The tracer is the global one the OTel SDK registers
// (src/instrumentation.ts); with no SDK started (tests, or a bare run without
// `--import`) it is a no-op tracer, so this adds nothing. `ignoreError` leaves
// exception recording to the error-reporter boundary (foundation/error-reporter.ts)
// so a thrown error is not double-recorded. Neither `includeArgs` NOR
// `includeSource` is enabled: both would put client-supplied argument VALUES on
// the span — `includeArgs` directly, `includeSource` by serializing the query AST
// (which reproduces inline-literal arguments verbatim) — and neither is covered
// by the variable redactor, which masks `variableValues`, not the query document.
const createResolverSpan = createOpenTelemetryWrapper(trace.getTracer('gannet-graphql'), {
  ignoreError: true,
});

/**
 * Pothos schema builder.
 *
 * This module intentionally imports NO feature modules — only the `Context`
 * *type*. Feature modules import the builder, so importing them here would
 * create a cycle. The Prisma client is pulled from the request context
 * (`client: (ctx) => ctx.db`) rather than a module-level singleton, which
 * decouples the builder from how the client is constructed (see app.ts).
 */
export const builder = new SchemaBuilder<{
  Context: Context;
  PrismaTypes: PrismaTypes;
}>({
  plugins: [PrismaPlugin, TracingPlugin],
  // Trace ROOT fields only (`isRootField`): a span per Query/Mutation entry
  // point, not per resolved field. Tracing every field would explode span
  // counts as O(fields × list length) with no added signal — the lesson crepe's
  // Sentry tracing also encodes, here vendor-neutral via OpenTelemetry.
  tracing: {
    default: (config) => isRootField(config),
    wrap: (resolver, options) => createResolverSpan(resolver, options),
  },
  prisma: {
    // At runtime the plugin only READS (relation loading for `t.relation` /
    // `query` spreads), but its type wants the full client. `ctx.db` IS the
    // real (routed) PrismaClient underneath, so this widening is honest. (The
    // other sanctioned widening of the routed client is `writer(ctx)` in
    // context.ts, for a tier-1 mutation's direct write.)
    client: (ctx) => ctx.db as PrismaClient,
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
