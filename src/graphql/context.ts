import type { Client, EvaluationContext } from '@openfeature/server-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getOperationAST, OperationTypeNode, parse } from 'graphql';
import type { Db, DbClient, ReadDbClient } from '../db/db.js';
import type { AppEventSubscriber } from '../events/event-registry.js';
import { createFlagReader } from '../flags/flag-reader.js';
import { FLAGS, type FlagReader } from '../flags/flag-registry.js';
import { UnauthenticatedError } from '../foundation/errors.js';
import type { Logger } from '../foundation/logger.js';
import { parseCredential, type Principal } from '../modules/auth/auth.value.js';
import type { Services } from '../services.js';

/** What kind of GraphQL operation this request is — decided once, per request. */
export type OperationKind = 'query' | 'mutation' | 'subscription' | 'other';

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
  /**
   * The request-scoped logger — Fastify's per-request child (`req.log`, already
   * bound to this request's id) further bound with the operation kind. Every
   * line it writes carries the request id and, once an OTel span is active, the
   * trace id (see foundation/logger.ts `traceContextMixin`), so a resolver's
   * logs, the operation-log line, and the request's trace all share one key.
   * A resolver or use-case logs through this, never through `ctx.req.log` or a
   * module-level logger.
   */
  logger: Logger;
  /**
   * The READ half of the event bus. A subscription field reaches its stream
   * through this and only this — the type carries `subscribe` and NOT `publish`,
   * so "a resolver cannot emit an event" is a compile-time fact rather than a
   * review comment. It is the `ReadDbClient` move applied to the bus; publishing
   * belongs to a service, which is the choke point every caller passes through.
   */
  events: AppEventSubscriber;
  /**
   * Who this request is, when a credential resolved to a live session — see
   * `modules/auth/`. OPTIONAL because most of this API is anonymous, and because
   * a required field would make every hand-built `Context` in a test a compile
   * error. A field that needs identity calls `requirePrincipal(ctx)` rather than
   * narrowing this itself.
   *
   * For a SUBSCRIPTION this is resolved once, at subscribe time, and then held
   * for the life of the socket — it does not re-validate as the session ages.
   * That is the same staleness `ctx.flags` has on a long-lived stream (see
   * `flags` above); a field that must reject a revoked session mid-stream has to
   * re-check inside `resolve`.
   */
  principal?: Principal;
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

/**
 * Requires an authenticated principal, or throws.
 *
 * The `writer(ctx)` of identity: a free function beside it, a runtime guard, and
 * a throw when it cannot deliver — so a field that needs a user writes
 * `requirePrincipal(ctx).userId` instead of threading a nullable through its
 * body. The difference is the error KIND. `writer` throws a plain Error because
 * calling it from a query is a programmer mistake and deserves a masked 500;
 * this throws a `DomainError` because an anonymous caller is an ordinary,
 * client-visible outcome that should arrive as `UNAUTHENTICATED`.
 *
 * It is deliberately NOT called in the context factory. Yoga awaits the factory
 * before parsing, so throwing there would fail every anonymous query too; the
 * factory resolves a principal or leaves it absent, and the FIELD decides whether
 * absence is fatal.
 */
export function requirePrincipal(ctx: Context): Principal {
  if (ctx.principal === undefined) {
    throw new UnauthenticatedError();
  }
  return ctx.principal;
}

/** Long-lived dependencies created once in the composition root (app.ts). */
export interface ContextDeps {
  db: Db;
  services: Services;
  /**
   * The subscriber half of the bus, closed over once. Long-lived, like `db` —
   * NOT per-request state, so it is built in the composition root and handed
   * straight through to every context.
   */
  events: AppEventSubscriber;
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
function buildEvalContext(principal: Principal | null): EvaluationContext {
  // `targetingKey` is OpenFeature's per-subject key: with it set, a provider can
  // roll a flag out to a percentage of users rather than all-or-nothing. The
  // DB-backed provider is stage + time-window only and ignores it, so this
  // changes no behavior today — it closes the seam so that switching to a
  // targeting provider is a provider change with no call-site edits.
  return principal === null ? {} : { targetingKey: String(principal.userId) };
}

/**
 * Resolves the request's credential to a principal, or null.
 *
 * Both transports funnel through ONE pure parser: the HTTP path supplies the
 * cookie and `Authorization` headers, the WebSocket path supplies those (a WS
 * upgrade is an ordinary HTTP request) plus the legacy `connectionParams`. That
 * is the whole reason `parseCredential` takes a structural shape instead of a
 * `FastifyRequest` — crepe's equivalent is an if/else chain duplicated per
 * transport, and this is the same rule stated once and property-tested.
 *
 * An anonymous request pays NO database round-trip: the parse happens first and
 * short-circuits. Failure to resolve is not an error here (see
 * `requirePrincipal`); a dead or expired token is simply anonymous.
 */
async function resolvePrincipal(
  deps: ContextDeps,
  req: FastifyRequest,
  connectionParams: unknown,
): Promise<Principal | null> {
  const credential = parseCredential({
    cookieHeader: req.headers.cookie,
    authorization: req.headers.authorization,
    connectionParams,
  });
  if (credential === null) return null;
  return deps.services.session.resolvePrincipal(credential);
}

/** The per-request values Yoga hands the context factory. */
export interface ContextRequest {
  req: FastifyRequest;
  reply: FastifyReply;
  /** Yoga's raw GraphQL params (the query string is inspected for routing). */
  params?: { query?: string | null; operationName?: string | null };
  /**
   * graphql-ws `connectionParams`, present only on the WebSocket path (the WS
   * handler passes them through; see app.ts). Untrusted and unshaped — the pure
   * parser narrows them. The HTTP path leaves this absent, which is why both
   * transports can share one factory.
   */
  connectionParams?: unknown;
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
    if (operation?.operation === OperationTypeNode.SUBSCRIPTION) return 'subscription';
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
 * - `subscription`      → `rw`, and this one is NOT obvious. A subscription's
 *   per-event `resolve` looks like a plain read, so the replica seems right. It
 *   is not: the event exists BECAUSE a transaction committed on the primary a
 *   moment ago, so the read is causally downstream of a write that the replica
 *   may not have yet — and the re-fetch is a `findUniqueOrThrow`, which does not
 *   degrade gracefully, it throws and kills the stream. Routing it here used to
 *   happen by accident (a subscription classified as `other`); it is explicit
 *   now so the reason survives.
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
  return async ({ req, reply, params, connectionParams }: ContextRequest): Promise<Context> => {
    const operation = classifyOperation(params);
    const principal = await resolvePrincipal(deps, req, connectionParams);
    return {
      db: routeClient(deps.db, operation),
      operation,
      services: deps.services,
      events: deps.events,
      ...(principal === null ? {} : { principal }),
      flags: createFlagReader(FLAGS, deps.flagClient, buildEvalContext(principal)),
      logger: req.log.child({ operation }),
      req,
      reply,
    };
  };
}
