import type { Agenda } from 'agenda';
import type { Services } from '../services.js';
import { createAgenda, type CreateAgendaOptions } from './agenda.js';
import type { JobSchedule } from './job.js';
import { registerOutboxJobs } from '../events/outbox.job.js';
import type { Outbox } from '../events/outbox.js';
import { registerFeatureFlagJobs } from '../modules/feature-flag/jobs/feature-flag.job.js';
import { registerPointJobs } from '../modules/point/jobs/point.job.js';

export interface BuildSchedulerOptions extends CreateAgendaOptions {
  /** The service container — each job module receives its own service from here. */
  services: Services;
  /**
   * The outbox. A peer of `services` rather than a member of it: the container
   * holds domain use-cases, and the outbox is infrastructure that those use-cases
   * write THROUGH. Its jobs still take exactly one dependency, so they satisfy
   * the same `JobRegistrar<T>` contract every module job does.
   */
  outbox: Outbox;
}

export interface Scheduler {
  readonly agenda: Agenda;
  /** Every recurring schedule the modules contributed, as inspectable data. */
  readonly schedules: readonly JobSchedule[];
  /** Connect, apply the `every()` schedules, and drop jobs no longer defined. */
  start(): Promise<void>;
  /** Finish in-flight jobs, then stop (closing the connection agenda owns). */
  stop(): Promise<void>;
}

/**
 * Assembles the scheduler — the `graphql/schema.ts` analogue for background
 * jobs. Each module contributes through ONE `registerXxxJobs(agenda, service)`
 * (explicit calls, not side-effect imports as crepe's `tasks/index.ts` uses):
 * the call DEFINES the handlers and RETURNS the schedules, applied together in
 * `start()`. A module dropped from this list is visibly absent (its import
 * flagged unused), the same guard `schema.ts` gives the GraphQL surface. The
 * service each job module needs comes from the container built once in the
 * composition root, never a db handle — jobs are delivery.
 */
export function buildScheduler(options: BuildSchedulerOptions): Scheduler {
  const agenda = createAgenda(options);
  const { services } = options;

  const schedules: JobSchedule[] = [
    ...registerFeatureFlagJobs(agenda, services.featureFlag),
    ...registerPointJobs(agenda, services.point),
    ...registerOutboxJobs(agenda, options.outbox),
  ];

  return {
    agenda,
    schedules,
    async start() {
      await agenda.start();
      for (const schedule of schedules) {
        // eslint-disable-next-line no-await-in-loop -- one recurring upsert per schedule; order does not matter
        await agenda.every(schedule.interval, schedule.name, undefined, schedule.options);
      }
      // Drop DB rows for jobs whose names are no longer defined — the code-owned
      // replacement for crepe's manual `agenda.cancel({ name })` list. `purge`
      // removes every orphan at once, so deleting a job module (and its
      // `define`) is all it takes for its queued rows to be reaped on next boot.
      await agenda.purge();
    },
    async stop() {
      // Graceful: wait for running jobs to finish, then stop. Closes the pg
      // connection agenda owns (a backend handed an external pool is left open).
      await agenda.drain();
    },
  };
}
