import './foundation/env.js';
// Imported before ./app.js so the OTel SDK starts before `http`/`pg` are loaded
// even when the process is launched without `--import` (the scripts DO use
// `--import`, which starts it earlier still; this import is then a cache hit and
// only yields the shutdown handle). See src/instrumentation.ts.
import { shutdownTelemetry } from './instrumentation.js';
import { buildApp } from './app.js';
import { otelErrorReporter } from './foundation/error-reporter.js';
import { buildScheduler } from './scheduler/scheduler.js';

// Bind the vendor-neutral error reporter once and share it across the GraphQL
// app and the scheduler, so both report unexpected errors down the same OTLP
// pipeline as traces (no separate error-tracking SDK / DSN).
const errorReporter = otelErrorReporter;
const { app, services } = buildApp({ errorReporter });
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
  : buildScheduler({ services, logger: app.log, errorReporter });

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
  await app.close();
  await shutdownTelemetry();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
