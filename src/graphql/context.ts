import type { Client, EvaluationContext } from '@openfeature/server-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getOperationAST, OperationTypeNode, parse } from 'graphql';
import type { Db, DbClient, ReadDbClient } from '../db/db.js';
import { createFlagReader } from '../flags/flag-reader.js';
import { FLAGS, type FlagReader } from '../flags/flag-registry.js';
import type { Services } from '../services.js';

/** What kind of GraphQL operation this request is — decided once, per request. */
export type OperationKind = 'query' | 'mutation' | 'other';

/** Per-request GraphQL context handed to every resolver. */
export interface Context {
  /**
   * The routed database client — the ONE handle a resolver touches, whatever
   * the operation. Typed as `ReadDbClient` (no write methods), so a resolver
   * cannot write through it *by construction* — that compile-time floor is the
   * whole reason there is a single name instead of a read/write pair. Routed
   * per operation: `ro` for queries (replica lag is fine for plain reads), `rw`
   * for mutations (so a mutation's re-fetch reads-its-own-writes) — see
   * `routeClient`.
   *
   * A tier-1 mutation that must write directly widens this same handle through
   * `writer(ctx)` (below) — the one sanctioned, and runtime-guarded, write path
   * out of a resolver.
   */
  db: ReadDbClient;
  /**
   * The operation kind, decided once by the factory. Its only consumer is
   * `writer()`, which reads it to refuse write access outside a mutation;
   * resolvers should not branch on it.
   */
  operation: OperationKind;
  services: Services;
  /**
   * The per-request feature-flag reader, bound to the app's OpenFeature client
   * and this request's evaluation context. Reads are memoized per request, so a
   * flag read here and in the service it calls always agree (see `flag-reader.ts`).
   * A resolver gates exposure with `ctx.flags.assert.<gate>()` or passes the
   * reader to a use-case that owns the decision (see `point.transfer`).
   */
  flags: FlagReader;
  req: FastifyRequest;
  reply: FastifyReply;
}

/**
 * Widens the routed client to a full `DbClient` for a tier-1 mutation's direct
 * write (see `post/`). This is the codebase's single write path from a
 * resolver, and it is honest: during a mutation `ctx.db` IS `db.rw` (the
 * factory routes it there), so the cast reveals a capability the object already
 * has — it does not fabricate one. The runtime guard makes the type safe: call
 * it from a query resolver (where `ctx.db` is the read-only replica) and it
 * throws instead of handing back a client that cannot write.
 *
 * Graduated modules never call this — their mutations write through
 * `ctx.services.*`, which owns transactions and the concurrency ladder.
 */
export function writer(ctx: Context): DbClient {
  if (ctx.operation !== 'mutation') {
    throw new Error('writer(ctx) is mutation-only: a query resolver has no write path');
  }
  return ctx.db as DbClient;
}

/** Long-lived dependencies created once in the composition root (app.ts). */
export interface ContextDeps {
  db: Db;
  services: Services;
  /**
   * The app's OpenFeature client (bound to the DB-backed provider in app.ts).
   * One client, closed over here; a fresh per-request reader is built from it.
   */
  flagClient: Client;
}

/**
 * The per-request OpenFeature evaluation context — the targeting seam. Empty
 * today: gannet has no authenticated principal on the GraphQL context (auth is a
 * separate OAuth REST flow that provisions users out of band). When a principal
 * lands, set `targetingKey` (the user id) here; every flag read already forwards
 * this context to the provider, so per-user targeting becomes a provider change
 * with no call-site edits. The crepe DB provider is stage + time-window only, so
 * it ignores the context regardless.
 */
function buildEvalContext(_req: FastifyRequest): EvaluationContext {
  return {};
}

/** The per-request values Yoga hands the context factory. */
export interface ContextRequest {
  req: FastifyRequest;
  reply: FastifyReply;
  /** Yoga's raw GraphQL params (the query string is inspected for routing). */
  params?: { query?: string | null; operationName?: string | null };
}

/**
 * Classifies the request's operation type by parsing the document once.
 *
 * The document is parsed here even though Yoga parses it again later; a
 * production app would hoist this into an envelop plugin to reuse Yoga's parse
 * result. The reference keeps it inline so the routing rule stays in one place.
 * Anything unparseable is `other` — Yoga's own validation rejects it right
 * after, so the resolver never runs.
 */
function classifyOperation(params?: {
  query?: string | null;
  operationName?: string | null;
}): OperationKind {
  if (!params?.query) return 'other';
  try {
    const operation = getOperationAST(parse(params.query), params.operationName ?? undefined);
    if (operation?.operation === OperationTypeNode.QUERY) return 'query';
    if (operation?.operation === OperationTypeNode.MUTATION) return 'mutation';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * Routes the request's client between the primary and the replica by operation:
 *
 * - `query`             → `ro`. Plain reads are projections; replica lag is fine.
 * - `mutation` / `other`→ `rw`. A mutation's re-fetch (plus any `t.relation`
 *   under it) must read-your-writes, and correctness beats replica offload for
 *   anything we could not classify.
 *
 * With no replica configured (`db.ro === db.rw`) everything is the primary.
 */
function routeClient(db: Db, operation: OperationKind): ReadDbClient {
  return operation === 'query' ? db.ro : db.rw;
}

/**
 * Builds the per-request context factory.
 *
 * The expensive, long-lived dependencies (db, services) are created once and
 * closed over here; only request-scoped values (req/reply, the routed client,
 * the operation kind) are computed per call. This is the single place where
 * dependencies enter the GraphQL layer.
 */
export function createContextFactory(deps: ContextDeps) {
  return ({ req, reply, params }: ContextRequest): Context => {
    const operation = classifyOperation(params);
    return {
      db: routeClient(deps.db, operation),
      operation,
      services: deps.services,
      flags: createFlagReader(FLAGS, deps.flagClient, buildEvalContext(req)),
      req,
      reply,
    };
  };
}
