import { OpenFeature, type Provider } from '@openfeature/server-sdk';
import type { PrismaClient } from '@prisma/client';
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { createContextFactory } from './graphql/context.js';
import { createServices } from './services.js';
import { createDb, disconnectDb, type Db } from './db/db.js';
import { type Clock, systemClock } from './foundation/clock.js';
import { isDomainError } from './foundation/errors.js';
import type { GoogleOAuthClient } from './modules/auth/oauth.provider.js';
import { registerGoogleOAuth } from './modules/auth/routes/oauth.route.js';
import { parseStage, type Stage } from './modules/feature-flag/feature-flag.core.js';
import { DbFeatureFlagProvider } from './modules/feature-flag/feature-flag.provider.js';
import type { PostSearchIndex } from './modules/search/post-search.provider.js';
import { schema } from './graphql/schema.js';

/** Context Yoga receives from Fastify per request. */
export interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface BuildAppOptions {
  /** Inject both database handles (e.g. distinct rw/ro test databases). */
  db?: Db;
  /**
   * Inject a single PrismaClient used as BOTH `rw` and `ro` (the common test
   * setup — routing rules still apply, they just route to one database).
   * Ignored when `db` is given.
   */
  prisma?: PrismaClient;
  /** Toggle Fastify request logging (default: true). */
  logger?: boolean;
  /**
   * Inject a Google OAuth client. Production omits this (an unimplemented stub
   * is used); tests pass a fake so the OAuth callback can be exercised.
   */
  googleOAuth?: GoogleOAuthClient;
  /**
   * Inject a post search index. Production omits this (an unimplemented stub is
   * used); tests pass a fake in-memory index so `searchPosts` can be exercised.
   */
  postSearchIndex?: PostSearchIndex;
  /**
   * Inject an OpenFeature provider. Production omits this (the DB-backed
   * `DbFeatureFlagProvider` is used); tests pass the SDK's `InMemoryProvider` to
   * fix flag values, or omit it and drive flags through the real DB provider.
   */
  flagProvider?: Provider;
  /**
   * Override the deploy stage the DB provider evaluates against (default:
   * `parseStage(process.env.STAGE)`). Tests pin it here instead of mutating env.
   */
  stage?: Stage | null;
  /**
   * Inject the clock (default: `systemClock`). One clock flows to both the
   * services (point expiry) and the DB flag provider (its window evaluation), so
   * a test's fixed clock makes every time-sensitive path deterministic at once.
   */
  clock?: Clock;
}

/**
 * Composition root: constructs the database handles and services, injects them
 * into the GraphQL context, and assembles the Fastify + Yoga app.
 *
 * Returns the (not-yet-listening) app so tests can import and drive it without
 * binding a port. See src/server.ts for the process entrypoint.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const injectedDb: Db | undefined =
    options.db ?? (options.prisma ? { rw: options.prisma, ro: options.prisma } : undefined);
  const db: Db = injectedDb ?? createDb();
  // Only handles the app itself created are disconnected on close — an
  // injected client stays the injector's to manage (two apps may share one).
  const ownsDb = injectedDb === undefined;
  const clock = options.clock ?? systemClock;
  const services = createServices(db, {
    googleOAuth: options.googleOAuth,
    postSearchIndex: options.postSearchIndex,
    clock,
  });

  // Feature flags via OpenFeature. The DB-backed provider evaluates the crepe
  // rule (stage + window + soft-delete); tests may inject an `InMemoryProvider`.
  // Register under a per-app domain so parallel in-process apps (test files) get
  // isolated providers, and read through that domain's client. `setProvider` is
  // synchronous and the provider needs no async init, so `buildApp` stays sync.
  const stage = options.stage ?? parseStage(process.env.STAGE);
  const flagProvider = options.flagProvider ?? new DbFeatureFlagProvider(db.rw, stage, clock);
  const flagDomain = crypto.randomUUID();
  OpenFeature.setProvider(flagDomain, flagProvider);
  const flagClient = OpenFeature.getClient(flagDomain);

  const app = fastify({ logger: options.logger ?? true });

  const yoga = createYoga<ServerContext>({
    schema,
    graphqlEndpoint: '/graphql',
    context: createContextFactory({ db, services, flagClient }),
    // Expected domain errors reach the client with their message + code;
    // everything else is masked as a generic internal error.
    maskedErrors: {
      maskError(error, message) {
        // Unwrap the located GraphQLError's originalError structurally (no
        // `instanceof`, which can fail across module realms in test runners).
        const original = (error as { originalError?: unknown })?.originalError ?? error;
        if (isDomainError(original)) {
          return new GraphQLError(original.message, { extensions: { code: original.code } });
        }
        return new GraphQLError(message);
      },
    },
    logging: {
      debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
      info: (...args) => args.forEach((arg) => app.log.info(arg)),
      warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
      error: (...args) => args.forEach((arg) => app.log.error(arg)),
    },
  });

  // Let Fastify forward multipart requests to Yoga (needed for file uploads).
  app.addContentTypeParser('multipart/form-data', {}, (_req, _payload, done) => done(null));

  app.route({
    url: yoga.graphqlEndpoint,
    method: ['GET', 'POST', 'OPTIONS'],
    handler: (req, reply) => yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
  });

  // Non-GraphQL surface: the Google OAuth callback. It is handed exactly one
  // dependency — services.auth, from the same container the GraphQL layer uses
  // — so the REST handler provisions users without ever seeing the database
  // handles or the GraphQL per-request context. See src/modules/auth/.
  registerGoogleOAuth(app, services.auth);

  app.addHook('onClose', async () => {
    if (ownsDb) {
      await disconnectDb(db);
    }
    // Deliberately NOT OpenFeature.close(): the registry is process-global, so
    // closing it here would tear down sibling apps' providers (parallel test
    // files share the process). The DB-backed provider holds no resources of its
    // own — the db handle it reads is disconnected above — so there is nothing
    // app-scoped to release. A stateful provider (a polling flagd client) would
    // instead be closed per-domain with `OpenFeature.close(flagDomain)`.
  });

  return { app, db, services, yoga };
}
