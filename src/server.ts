import './foundation/env.js';
// Imported before ./app.js so the OTel SDK starts before `http`/`pg` are loaded
// even when the process is launched without `--import` (the scripts DO use
// `--import`, which starts it earlier still; this import is then a cache hit and
// only yields the shutdown handle). See src/instrumentation.ts.
import { shutdownTelemetry } from './instrumentation.js';
import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import {
  compositeErrorReporter,
  otelErrorReporter,
  sentryErrorReporter,
} from './foundation/error-reporter.js';
import { createRedisFanout } from './events/redis-event-target.js';
import { buildScheduler } from './scheduler/scheduler.js';

// Sentry is OPTIONAL error tracking, enabled only when SENTRY_DSN is set (from
// env — never hardcoded). `skipOpenTelemetrySetup: true` is REQUIRED: it stops
// Sentry registering its own tracer/context-manager on the global OTel API,
// which would fight the app's own NodeSDK (instrumentation.ts). Sentry is then a
// pure error sink (`captureException`); tracing stays OTel's, exported wherever
// the collector points (Jaeger, and/or Sentry itself over OTLP — see README).
const sentryEnabled = Boolean(process.env.SENTRY_DSN);
if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.STAGE,
    release: process.env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
    // tracesSampleRate is OMITTED on purpose — NOT set to 0. `hasSpansEnabled` is
    // a `!= null` check, so even `0` counts as "tracing on" and pulls in Sentry's
    // auto-performance integrations (postgres/fastify/graphql/prisma). Those
    // register their OWN OTel instrumentations that emit through the global
    // provider — the app's NodeSDK — producing DUPLICATE spans in the trace
    // backend. `getDefaultIntegrationsWithoutPerformance()` makes the no-tracing
    // intent explicit and robust against a future tracesSampleRate.
    sendDefaultPii: false,
    // Authoritative, version-independent switch: never capture stack-frame local
    // variable VALUES. This is the control we rely on — the integration's own name
    // changed across Node versions ('LocalVariables' → 'LocalVariablesAsync' on
    // Node ≥ 19), so a name filter alone is not trustworthy.
    includeLocalVariables: false,
    // Report errors EXPLICITLY via captureException (with a chosen extra/tags).
    // Drop the default integrations that auto-enrich events with data that
    // egresses to Sentry SaaS and can carry secrets/PII: RequestData (request URL
    // + query string — the OAuth `code`/`state`, GraphQL variables on a GET;
    // Sentry's scrubbing is a denylist that omits `code`/`state`), ContextLines
    // (source lines at the throw site), and LocalVariables (frame local values;
    // both its sync and Node≥19 async names are listed — belt to
    // includeLocalVariables:false above).
    defaultIntegrations: Sentry.getDefaultIntegrationsWithoutPerformance().filter(
      (integration) =>
        !['RequestData', 'LocalVariables', 'LocalVariablesAsync', 'ContextLines'].includes(
          integration.name,
        ),
    ),
    // Name-independent backstop: strip any request context that still slips in.
    beforeSend(event) {
      delete event.request;
      return event;
    },
  });
}

// One error reporter, shared by the GraphQL app and the scheduler. With Sentry
// on, fan out to BOTH the OTel span (trace backends) AND Sentry Issues; with it
// off, just the span. Neither path is reached by expected DomainErrors.
const errorReporter = sentryEnabled
  ? compositeErrorReporter(otelErrorReporter, sentryErrorReporter())
  : otelErrorReporter;
// Subscriptions fan out across instances only when a Redis URL is configured.
// Without one the bus stays in-process, which is correct for a single instance
// and is what every test runs on — the reference never requires Redis to boot.
// This is the ONE place a backend is chosen; swapping it (for a Postgres
// LISTEN/NOTIFY target, say) is a new driver file plus this line.
const fanout = process.env.REDIS_URL ? createRedisFanout(process.env.REDIS_URL) : null;

const { app, services, outbox } = buildApp({
  errorReporter,
  ...(fanout === null ? {} : { eventTarget: fanout.target }),
});
const port = Number(process.env.PORT ?? 4000);

// The background-job scheduler is a SEPARATE process concern from serving
// GraphQL: it is built only here (never in buildApp, which tests construct many
// times), and gated by one env switch — the reference's counterpart to crepe's
// `STAGE=stg` / `NOT_RUN_AGENDA` guards, which keep only designated processes
// polling the queue. Default ON; set SCHEDULER_ENABLED=false to serve without
// processing jobs. Building it opens agenda's own pg connection immediately, so
// a disabled scheduler opens none.
const scheduler = process.env.SCHEDULER_ENABLED === 'false'
  ? null
  : buildScheduler({ services, outbox, logger: app.log, errorReporter });

try {
  await app.listen({ port, host: '0.0.0.0' });
  if (scheduler) {
    await scheduler.start();
    app.log.info('🗓  scheduler started');
  }
  app.log.info(`🚀 GraphQL ready at http://localhost:${port}/graphql`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async () => {
  // Guard against a second signal racing the first teardown (e.g. SIGINT then
  // SIGTERM); shutdownTelemetry is idempotent regardless, but this avoids a
  // double scheduler.stop()/app.close().
  if (shuttingDown) return;
  shuttingDown = true;
  // Drain in-flight jobs before tearing down the app so a job mid-write is not
  // cut off; then close the server (its onClose hook runs prisma.$disconnect());
  // then flush telemetry LAST so the final buffered spans/metrics are not lost
  // (timeboxed inside shutdownTelemetry so a stuck exporter cannot hang exit).
  if (scheduler) await scheduler.stop();
  // Hand off whatever committed but has not gone out yet. Not required for
  // correctness — another instance's drain, or this one's on next boot, would
  // pick these up — but it turns a routine deploy from "some events arrive up to
  // 30s late" into "none do". Never fatal: if it throws, the rows simply stay
  // pending, which is the state the outbox is designed to recover from.
  try {
    await outbox.drain();
  } catch (error) {
    app.log.error({ err: error }, 'final outbox drain failed; rows remain pending');
  }
  // Closing the server also closes live WebSockets, which ends every subscription
  // and lets clients reconnect to a healthy instance (graphql-ws clients retry).
  // This is the gap crepe's `main.ts` still has a TODO for.
  await app.close();
  // Redis last among the app's own resources: the drain above needed it.
  if (fanout) await fanout.close();
  await shutdownTelemetry();
  // Flush + disable Sentry last (awaited, timeboxed) so queued error events are
  // not lost on exit. close() drains then disables the client.
  if (sentryEnabled) await Sentry.close(2000);
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
