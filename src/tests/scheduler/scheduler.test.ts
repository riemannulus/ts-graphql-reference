import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'agenda';
import type { Services } from '../../services.js';
import { buildScheduler } from '../../scheduler/scheduler.js';
import { FEATURE_FLAG_PURGE_JOB } from '../../modules/feature-flag/jobs/feature-flag.job.js';
import { POINT_BALANCE_VERIFY_JOB } from '../../modules/point/jobs/point.job.js';
import { OUTBOX_DRAIN_JOB, OUTBOX_PURGE_JOB } from '../../events/outbox.job.js';
import { fakeOutbox } from '../support/event-bus-fake.js';
import { fakeAgendaBackend } from '../support/agenda-backend-fake.js';

// The scheduler assembled with a FAKE backend and never started: defining
// handlers and collecting schedules never touch the job store (only start /
// every / purge do). This is the job-registry guard — the scheduler analogue of
// the SDL snapshot: a module dropped from buildScheduler's register list, or a
// renamed job / changed interval, fails loudly here.

/** A services container whose only real members are the two the jobs call. */
function servicesWith(overrides: {
  purgeDeleted?: (opts?: { now?: Date; retentionDays?: number }) => Promise<number>;
  verifyBalances?: () => Promise<{ usersChecked: number }>;
}): Services {
  return {
    featureFlag: { purgeDeleted: overrides.purgeDeleted ?? (() => Promise.resolve(0)) },
    point: { verifyBalances: overrides.verifyBalances ?? (() => Promise.resolve({ usersChecked: 0 })) },
  } as unknown as Services;
}

/** Runs a defined job's handler once (promise-style; job/done args unused here). */
function runJob(scheduler: ReturnType<typeof buildScheduler>, name: string): Promise<void> {
  const definition = scheduler.agenda.definitions[name];
  if (!definition) throw new Error(`job not defined: ${name}`);
  return definition.fn({} as unknown as Job, () => {}) as Promise<void>;
}

describe('buildScheduler', () => {
  it('defines exactly the modules’ jobs and returns their schedules', () => {
    const scheduler = buildScheduler({
      services: servicesWith({}),
      outbox: fakeOutbox(),
      backend: fakeAgendaBackend(),
    });

    expect(Object.keys(scheduler.agenda.definitions).toSorted()).toEqual(
      [FEATURE_FLAG_PURGE_JOB, POINT_BALANCE_VERIFY_JOB, OUTBOX_DRAIN_JOB, OUTBOX_PURGE_JOB].toSorted(),
    );

    // The recurring registry, as data — guarded like the SDL snapshot.
    expect([...scheduler.schedules].toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: OUTBOX_DRAIN_JOB, interval: '30 seconds' },
      { name: OUTBOX_PURGE_JOB, interval: '0 4 * * *', options: { skipImmediate: true } },
      { name: FEATURE_FLAG_PURGE_JOB, interval: '0 3 * * *', options: { timezone: 'Asia/Seoul' } },
      { name: POINT_BALANCE_VERIFY_JOB, interval: '15 minutes' },
    ].toSorted((a, b) => a.name.localeCompare(b.name)));
  });

  it('the feature-flag purge handler delegates to the service', async () => {
    const purgeDeleted = vi.fn(() => Promise.resolve(0));
    const scheduler = buildScheduler({
      services: servicesWith({ purgeDeleted }),
      outbox: fakeOutbox(),
      backend: fakeAgendaBackend(),
    });

    await runJob(scheduler, FEATURE_FLAG_PURGE_JOB);

    // Delegates without minting a clock: the service reads `now` from the
    // injected clock, so the handler passes no arguments.
    expect(purgeDeleted).toHaveBeenCalledWith();
  });

  it('the point verify handler delegates to the service', async () => {
    const verifyBalances = vi.fn(() => Promise.resolve({ usersChecked: 0 }));
    const scheduler = buildScheduler({
      services: servicesWith({ verifyBalances }),
      outbox: fakeOutbox(),
      backend: fakeAgendaBackend(),
    });

    await runJob(scheduler, POINT_BALANCE_VERIFY_JOB);

    expect(verifyBalances).toHaveBeenCalledOnce();
  });
});
