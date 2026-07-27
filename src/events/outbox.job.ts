import { defineJob, type JobRegistrar } from '../scheduler/job.js';
import type { Outbox } from './outbox.js';

/**
 * The outbox's SCHEDULED delivery — the fourth delivery kind beside `schemas/`,
 * `routes/` and a module's `jobs/`, and the only one the events facade needs.
 *
 * `notify()` covers the happy path in-process; these two jobs cover everything
 * it cannot. The drain is the AUTHORITY for delivery, not a backstop: it is what
 * picks up rows another instance enqueued, rows whose `notify()` was lost to a
 * crash, and rows left half-processed between the claim and the mark. Nothing may
 * depend on `notify()` having run.
 *
 * Consequence worth stating plainly, because it is an operational footgun: the
 * scheduler is built only in `server.ts` and is gated by `SCHEDULER_ENABLED`, so
 * **at least one process in the fleet must run the scheduler** or rung-1 events
 * only ever go out on the `notify()` path — fine until the first crash, then
 * silently stalled. See the README's scheduler note.
 */

/** Publishes committed-but-unsent events. */
export const OUTBOX_DRAIN_JOB = 'events:outbox:drain';
/** Removes delivered rows past their retention window. */
export const OUTBOX_PURGE_JOB = 'events:outbox:purge';

/**
 * Registers both jobs. The handlers are as thin as any other delivery layer:
 * they take no arguments, delegate to the outbox, and read no clock of their own
 * — `purge()` computes its own cutoff from the injected clock (CONVENTIONS §10).
 */
export const registerOutboxJobs: JobRegistrar<Outbox> = (agenda, outbox) => {
  defineJob(agenda, OUTBOX_DRAIN_JOB, async () => {
    await outbox.drain();
  });

  defineJob(agenda, OUTBOX_PURGE_JOB, async () => {
    await outbox.purge();
  });

  return [
    // 30 seconds: the worst-case delivery latency when `notify()` did not run
    // (another instance's row, or a crash between commit and wake-up). A drain
    // that finds nothing is one indexed query against the partial index.
    { name: OUTBOX_DRAIN_JOB, interval: '30 seconds' },
    // Retention is not urgent; nightly keeps the table small without competing
    // with the drain. `skipImmediate` so a deploy does not trigger a purge.
    { name: OUTBOX_PURGE_JOB, interval: '0 4 * * *', options: { skipImmediate: true } },
  ];
};
