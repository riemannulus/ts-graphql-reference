import { Agenda, type AgendaBackend } from 'agenda';
import { PostgresBackend } from '@agendajs/postgres-backend';
import { type ErrorReporter, noopErrorReporter } from '../foundation/error-reporter.js';

/**
 * The scheduler's logging sink — a structural subset of the app's Fastify/pino
 * logger (`app.log`), so the composition root passes that straight in and the
 * scheduler stays framework-agnostic (a test passes a recording fake, or omits
 * it to stay silent). `no-console` is a lint warning in this tree, so the
 * scheduler never writes to the console itself: it logs through this port.
 */
export interface SchedulerLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * The job name from a lifecycle event. agenda emits these with a LOCAL
 * `JobWithId` (`.attrs.name`) or — when the PostgresBackend re-broadcasts
 * another instance's event over LISTEN/NOTIFY — a remote `JobStateNotification`
 * (`.jobName`, no `.attrs`). Overload resolution types the listener arg as the
 * local shape, so read the name defensively to stay crash-free even if a NAMED
 * sibling scheduler publishes a remote event.
 */
function eventJobName(job: { attrs?: { name?: string }; jobName?: string }): string {
  return job.attrs?.name ?? job.jobName ?? 'unknown';
}

export interface CreateAgendaOptions {
  /**
   * Inject the storage/notification backend. Production omits this and gets a
   * `PostgresBackend` over `connectionString`; tests pass a fake `AgendaBackend`
   * — PGlite (the test database) cannot run agenda's real `pg` LISTEN/NOTIFY, so
   * the backend is the seam, the scheduler analogue of the OAuth / search stubs.
   */
  backend?: AgendaBackend;
  /**
   * Connection string for the default `PostgresBackend`. This is agenda's OWN
   * storage: it creates and owns its `agenda_jobs` table (+ indexes/trigger) on
   * connect. That table is NOT a Prisma model — Prisma never generates or
   * migrates it — and its lowercase name cannot collide with Prisma's quoted
   * PascalCase tables. It does, though, land in the same `public` schema by
   * default, so `prisma migrate dev` (development) reports it as an untracked
   * table (drift); `prisma migrate deploy` (production) does not drift-check, so
   * prod is unaffected. To remove even the dev notice, run agenda in a dedicated
   * Postgres schema Prisma does not track (see README "Background jobs").
   * Defaults to `DATABASE_URL` (the primary): a recurring job is written against,
   * and decides on, primary state, never a lagging replica.
   */
  connectionString?: string;
  /** Identifies this Agenda instance in logs and the jobs table. */
  name?: string;
  /** Where lifecycle events are logged (omit to stay silent). */
  logger?: SchedulerLogger;
  /**
   * Where a failed job / scheduler error is reported (the "forward it to its
   * error tracker" this doc mentions). Same narrow port the GraphQL/OAuth
   * boundaries use; defaults to a no-op, so a job failure is still logged.
   */
  errorReporter?: ErrorReporter;
}

/**
 * Builds the Agenda instance and wires its lifecycle events to the logger — the
 * reference analogue of crepe's `tasks/agenda.ts` (which logs start/success/fail
 * and captures failures to Sentry). This uses the ORIGINAL agenda (v6), whose
 * pluggable-backend rewrite lets a `pg`-backed queue replace crepe's forked,
 * MongoDB-only build. A failed job is logged here and reported through the
 * injected `errorReporter` (a no-op by default; server.ts binds the same
 * reporter the GraphQL app uses — OTel span, and Sentry when `SENTRY_DSN` is set).
 *
 * NOTE: constructing an `Agenda` connects the backend IMMEDIATELY (agenda's
 * constructor calls `backend.connect()`), so this is called only when the
 * scheduler is actually enabled (see `buildScheduler` / server.ts), never inside
 * `buildApp` — which tests construct many times and which must not open a job
 * queue connection.
 */
export function createAgenda(options: CreateAgendaOptions = {}): Agenda {
  const backend =
    options.backend ??
    new PostgresBackend({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
      tableName: 'agenda_jobs',
    });

  const agenda = new Agenda({ backend, name: options.name });

  const { logger } = options;
  const errorReporter = options.errorReporter ?? noopErrorReporter;
  if (logger) {
    agenda.on('ready', () => logger.info({}, 'scheduler ready'));
    agenda.on('start', (job) => logger.info({ job: eventJobName(job) }, 'job started'));
    agenda.on('success', (job) => logger.info({ job: eventJobName(job) }, 'job succeeded'));
  }
  // Failures are LOGGED (when a logger is set) and REPORTED (always). The report
  // is independent of logging so a deploy that binds an error tracker sees job
  // failures even if it runs the scheduler quietly.
  agenda.on('fail', (error, job) => {
    const name = eventJobName(job);
    logger?.error({ job: name, err: error }, 'job failed');
    errorReporter.capture(error, { job: name });
  });
  // agenda's own constructor attaches a no-op 'error' listener so an emitted
  // error never crashes the process; this one makes it observable.
  agenda.on('error', (error) => {
    logger?.error({ err: error }, 'scheduler error');
    errorReporter.capture(error, { scope: 'scheduler' });
  });

  return agenda;
}
