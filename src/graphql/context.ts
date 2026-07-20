import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getOperationAST, OperationTypeNode, parse } from 'graphql';
import type { Db } from '../db/db.js';
import type { Services } from '../services.js';

/** Per-request GraphQL context handed to every resolver. */
export interface Context {
  /**
   * The selection client: what the Pothos Prisma plugin (relations, `query`
   * spreads) and repo read calls in resolvers run on. Routed per operation —
   * `ro` for queries, `rw` for mutations — see `selectSelectionClient`.
   */
  prisma: PrismaClient;
  services: Services;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Long-lived dependencies created once in the composition root (app.ts). */
export interface ContextDeps {
  db: Db;
  services: Services;
}

/** The per-request values Yoga hands the context factory. */
export interface ContextRequest {
  req: FastifyRequest;
  reply: FastifyReply;
  /** Yoga's raw GraphQL params (the query string is inspected for routing). */
  params?: { query?: string | null; operationName?: string | null };
}

/**
 * Routes the request's selection client between the primary and the replica by
 * operation type:
 *
 * - `query`    → `ro`. Plain reads are projections; replica lag is acceptable.
 * - `mutation` → `rw`. The mutation's own writes AND the re-fetch that fills
 *   its selection set (plus any `t.relation` under it) must read-your-writes —
 *   a replica may not have the row yet.
 * - anything unparseable → `rw`. Correctness over replica offload; an invalid
 *   document fails in Yoga's own validation right after.
 *
 * The document is parsed once more here (Yoga parses it again later). A
 * production app would hoist this into an envelop plugin to reuse Yoga's parse
 * result; the reference keeps it inline so the routing rule is visible in one
 * place.
 */
export function selectSelectionClient(
  db: Db,
  params?: { query?: string | null; operationName?: string | null },
): PrismaClient {
  if (db.ro === db.rw || !params?.query) return db.rw;
  try {
    const operation = getOperationAST(parse(params.query), params.operationName ?? undefined);
    return operation?.operation === OperationTypeNode.QUERY ? db.ro : db.rw;
  } catch {
    return db.rw;
  }
}

/**
 * Builds the per-request context factory.
 *
 * The expensive, long-lived dependencies (db, services) are created once and
 * closed over here; only request-scoped values (req/reply, the routed
 * selection client) are computed per call. This is the single place where
 * dependencies enter the GraphQL layer.
 */
export function createContextFactory(deps: ContextDeps) {
  return ({ req, reply, params }: ContextRequest): Context => ({
    prisma: selectSelectionClient(deps.db, params),
    services: deps.services,
    req,
    reply,
  });
}
