import { useOpenTelemetry } from '@envelop/opentelemetry';
import { trace } from '@opentelemetry/api';
import { OpenFeature, type Provider } from '@openfeature/server-sdk';
import type { PrismaClient } from '@prisma/client';
import fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import websocket from '@fastify/websocket';
import type { TypedEventTarget } from '@graphql-yoga/typed-event-target';
import { GraphQLError } from 'graphql';
import { makeHandler } from 'graphql-ws/use/@fastify/websocket';
import { createYoga } from 'graphql-yoga';
import { createEventBus } from './events/event-bus.js';
import { TOPICS } from './events/event-registry.js';
import { createOutbox } from './events/outbox.js';
import { createContextFactory } from './graphql/context.js';
import { useOperationLog } from './graphql/plugins/operation-log.js';
import { createServices } from './services.js';
import { createDb, disconnectDb, type Db } from './db/db.js';
import { type Clock, systemClock } from './foundation/clock.js';
import { type ErrorReporter, noopErrorReporter } from './foundation/error-reporter.js';
import { isDomainError } from './foundation/errors.js';
import { LOG_REDACT_PATHS, parseLogLevel, traceContextMixin } from './foundation/logger.js';
import type { GoogleOAuthClient } from './modules/auth/oauth.provider.js';
import { registerGoogleOAuth } from './modules/auth/routes/oauth.route.js';
import { parseStage, type Stage } from './modules/feature-flag/feature-flag.core.js';
import { DbFeatureFlagProvider } from './modules/feature-flag/feature-flag.provider.js';
import type { PostSearchIndex } from './modules/search/post-search.provider.js';
import { schema } from './graphql/schema.js';

/**
 * Resolves the `logger` build option to a Fastify logger config. `false`
 * disables logging (tests); a config object is passed through (advanced
 * override); the default (`true` / omitted) builds the structured pino setup —
 * env-driven level, fail-closed header redaction, and the OTel trace-id mixin —
 * so every request line is queryable and correlated with its trace.
 */
function resolveLogger(logger: BuildAppOptions['logger']): FastifyServerOptions['logger'] {
  if (logger === false) return false;
  if (logger === undefined || logger === true) {
    return {
      level: parseLogLevel(process.env.LOG_LEVEL),
      redact: LOG_REDACT_PATHS,
      mixin: traceContextMixin,
    };
  }
  return logger;
}

/** Context Yoga receives from Fastify per request. */
export interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

/**
 * What `graphql-ws`'s Fastify adapter puts on `ctx.extra`. Declared structurally
 * rather than imported so the app does not depend on the adapter's internal
 * type; all we need is the upgrade request, which carries the cookies.
 */
interface WsExtra extends Record<PropertyKey, unknown> {
  request: FastifyRequest;
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
  /**
   * Logging control. `true`/omitted → the structured pino default (env-driven
   * `LOG_LEVEL`, header redaction, OTel trace-id correlation — see
   * `resolveLogger`); `false` → logging off (tests); a pino config object →
   * used as-is for advanced overrides. Level/redaction/genReqId are injected
   * through this one seam rather than bespoke options.
   */
  logger?: FastifyServerOptions['logger'];
  /**
   * Where unexpected (non-`DomainError`) errors are reported. `server.ts` picks
   * the binding from env — `otelErrorReporter` (records on the active span), or
   * `compositeErrorReporter(otel, sentry)` when `SENTRY_DSN` is set. The default
   * here is a no-op, so the reference and its tests need no error-tracking service.
   */
  errorReporter?: ErrorReporter;
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
  /**
   * Distributed fan-out for subscriptions. Omitted here and in every test, which
   * makes the bus in-process — the right default for one instance and the reason
   * the suite needs no Redis. `server.ts` builds the Redis-backed target when
   * `REDIS_URL` is set and closes it on shutdown.
   */
  eventTarget?: TypedEventTarget<CustomEvent>;
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
  const errorReporter = options.errorReporter ?? noopErrorReporter;

  // Fastify is constructed BEFORE the services so the outbox can take `app.log`
  // as its logger — it drains on a timer, outside any request, so it has no
  // `reqId` of its own and a named child is what makes a drain line greppable.
  const app = fastify({
    logger: resolveLogger(options.logger),
    // Mint a fresh request id per request and surface it on every log line as
    // `reqId` — the correlation key crepe lacked. It is minted, never read from
    // an inbound header: honoring `x-request-id` unconditionally lets a client
    // spoof the key, so trusting one is an explicit, proxy-gated extension.
    genReqId: () => crypto.randomUUID(),
    requestIdLogLabel: 'reqId',
  });

  // The event bus, built once. With no `eventTarget` injected it fans out
  // in-process — correct for a single instance and for every test, which is why
  // the suite never needs Redis. `server.ts` injects the Redis-backed target when
  // REDIS_URL is set. The bus is handed out in HALVES: services get the publisher,
  // the GraphQL context gets the subscriber, and neither can reach the other's
  // methods (see events/events.ts).
  const events = createEventBus(TOPICS, { eventTarget: options.eventTarget, clock });
  const outbox = createOutbox({
    db,
    bus: events,
    clock,
    logger: app.log.child({ component: 'outbox' }),
  });

  const services = createServices(db, {
    googleOAuth: options.googleOAuth,
    postSearchIndex: options.postSearchIndex,
    clock,
    events,
    outbox,
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

  const yoga = createYoga<ServerContext>({
    schema,
    graphqlEndpoint: '/graphql',
    context: createContextFactory({ db, services, flagClient, events }),
    // Envelop/Yoga cross-cutting seam. Order is load-bearing (first = outermost):
    // the operation log wraps everything so it is the single per-request record;
    // OpenTelemetry creates the per-operation span (root-field resolver spans are
    // added by Pothos — see builder.ts). Passing the GLOBAL tracer provider is
    // required: without it @envelop/opentelemetry registers its OWN provider and
    // forks the pipeline. `resolvers: false` avoids duplicate per-resolver spans
    // (Pothos owns those); `variables/result: false` keep request variables and
    // response payloads off the span.
    //
    // DATA EGRESS CAVEAT: @envelop/opentelemetry ALWAYS records GraphQL errors on
    // the span (its markError is not gated by these options), and — like the
    // operation-log line — it observes the PRE-mask errors (both run before Yoga's
    // maskError). So when OTLP export is on, the raw unmasked error content is
    // sent to the trace backend over the network. That is intended for debugging,
    // but makes "never put a secret or PII in an error message" a HARD invariant
    // (see graphql/plugins/operation-log.ts and the README "Observability" note),
    // not merely a local-logging nicety.
    plugins: [
      useOperationLog(),
      useOpenTelemetry(
        { resolvers: false, variables: false, result: false },
        trace.getTracerProvider(),
      ),
    ],
    // Expected domain errors reach the client with their message + code;
    // everything else is masked as a generic internal error AND reported. This is
    // the one place service-thrown errors enter the ErrorReporter port — service
    // code never touches it. (Tracing separately records errors on the span; see
    // the plugins-array caveat above.)
    maskedErrors: {
      maskError(error, message) {
        // Unwrap the located GraphQLError's originalError structurally (no
        // `instanceof`, which can fail across module realms in test runners).
        const original = (error as { originalError?: unknown })?.originalError ?? error;
        if (isDomainError(original)) {
          return new GraphQLError(original.message, { extensions: { code: original.code } });
        }
        errorReporter.capture(original);
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
  // Subscriptions over WebSocket — the graphql-ws protocol, for wire
  // compatibility with clients that already speak it (crepe's relay setup needs
  // only a URL change). SSE needs no code at all: Yoga serves subscriptions over
  // the SAME `/graphql` route above when the client sends
  // `Accept: text/event-stream`, which is the simpler default for new clients.
  //
  // `getEnveloped` is what makes the two transports behave identically: the WS
  // path runs the same plugins (operation log, OpenTelemetry) and the same
  // context factory as HTTP, rather than a parallel pipeline that drifts.
  // Both the plugin and the route go inside ONE encapsulated plugin, and the
  // inner register is AWAITED. This ordering is load-bearing, not style:
  // @fastify/websocket installs an `onRoute` hook when it finishes loading, and
  // `{ websocket: true }` is honored only for routes added AFTER that. Register
  // it without awaiting and the option is silently ignored — `makeHandler` is
  // then invoked as an ordinary HTTP handler, the upgrade dies with
  // "socket.once is not a function", and every WS client sees a 1006 close with
  // nothing in the logs to explain it.
  void app.register(async (instance) => {
    await instance.register(websocket);
    instance.get(
      '/graphql/ws',
      { websocket: true },
      makeHandler<Record<string, unknown>, WsExtra>({
        schema,
        onSubscribe: async (ctx, _id, payload) => {
          const {
            schema: wsSchema,
            parse: parseDocument,
            validate,
            contextFactory,
          } = yoga.getEnveloped({
            req: ctx.extra.request,
            // The legacy credential channel. A WS upgrade carries cookies like
            // any request, so this is only for clients that predate that.
            connectionParams: ctx.connectionParams,
          });
          const document = parseDocument(payload.query);
          const errors = validate(wsSchema, document);
          if (errors.length > 0) return errors;
          return {
            schema: wsSchema,
            operationName: payload.operationName,
            document,
            variableValues: payload.variables,
            contextValue: await contextFactory(),
          };
        },
      }),
    );
  });

  registerGoogleOAuth(app, services.auth, services.session, {
    // A `Secure` cookie is never returned over plain HTTP, and the reference runs
    // on HTTP locally — so the flag follows the deploy stage rather than being
    // hardcoded either way. Anything that is not a local/dev stage gets it.
    secureCookies: stage !== null && stage !== 'LOCAL' && stage !== 'DEV',
    errorReporter,
  });

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

  // `outbox` is returned so `server.ts` can drain it one last time on shutdown
  // and so an integration test can drive it without reaching into the container.
  return { app, db, services, yoga, events, outbox };
}
