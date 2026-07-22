import './foundation/env.js';
import { buildApp } from './app.js';
import { buildScheduler } from './scheduler/scheduler.js';

const { app, services } = buildApp();
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
  : buildScheduler({ services, logger: app.log });

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

const shutdown = async () => {
  // Drain in-flight jobs before tearing down the app so a job mid-write is not
  // cut off; then close the server (its onClose hook runs prisma.$disconnect()).
  if (scheduler) await scheduler.stop();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
