import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'agenda';
import type { Services } from '../../services.js';
import { buildScheduler } from '../../scheduler/scheduler.js';
import { FEATURE_FLAG_PURGE_JOB } from '../../modules/feature-flag/jobs/feature-flag.job.js';
import { POINT_BALANCE_VERIFY_JOB } from '../../modules/point/jobs/point.job.js';
import { fakeAgendaBackend } from '../support/agenda-backend-fake.js';

// The scheduler assembled with a FAKE backend and never started: defining
// handlers and collecting schedules never touch the job store (only start /
// every / purge do). This is the job-registry guard — the scheduler analogue of
// the SDL snapshot: a module dropped from buildScheduler's register list, or a
// renamed job / changed interval, fails loudly here.

/** A services container whose only real members are the ones the jobs call. */
function servicesWith(overrides: {
  purgeDeleted?: (opts?: { now?: Date; retentionDays?: number }) => Promise<number>;
  reconcile?: () => Promise<{ orphanLive: string[]; killedButDeclared: string[] }>;
  verifyBalances?: () => Promise<{ usersChecked: number }>;
}): Services {
  return {
    featureFlag: {
      purgeDeleted: overrides.purgeDeleted ?? (() => Promise.resolve(0)),
      reconcile:
        overrides.reconcile ?? (() => Promise.resolve({ orphanLive: [], killedButDeclared: [] })),
    },
    point: { verifyBalances: overrides.verifyBalances ?? (() => Promise.resolve({ usersChecked: 0 })) },
  } as unknown as Services;
}

/** A recording SchedulerLogger (the scheduler analogue of the fake OAuth client). */
function recordingLogger() {
  const warnings: Array<{ obj: object; msg?: string }> = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (obj: object, msg?: string) => warnings.push({ obj, msg }),
      error: () => {},
    },
  };
}

/** Runs a defined job's handler once (promise-style; job/done args unused here). */
function runJob(scheduler: ReturnType<typeof buildScheduler>, name: string): Promise<void> {
  const definition = scheduler.agenda.definitions[name];
  if (!definition) throw new Error(`job not defined: ${name}`);
  return definition.fn({} as unknown as Job, () => {}) as Promise<void>;
}

describe('buildScheduler', () => {
  it('defines exactly the modules’ jobs and returns their schedules', () => {
    const scheduler = buildScheduler({ services: servicesWith({}), backend: fakeAgendaBackend() });

    expect(Object.keys(scheduler.agenda.definitions).toSorted()).toEqual([
      FEATURE_FLAG_PURGE_JOB,
      POINT_BALANCE_VERIFY_JOB,
    ]);

    // The recurring registry, as data — guarded like the SDL snapshot.
    expect([...scheduler.schedules].toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: FEATURE_FLAG_PURGE_JOB, interval: '0 3 * * *', options: { timezone: 'Asia/Seoul' } },
      { name: POINT_BALANCE_VERIFY_JOB, interval: '15 minutes' },
    ]);
  });

  it('the feature-flag purge handler reconciles first, then delegates the purge', async () => {
    const calls: string[] = [];
    const reconcile = vi.fn(() => {
      calls.push('reconcile');
      return Promise.resolve({ orphanLive: [], killedButDeclared: [] });
    });
    const purgeDeleted = vi.fn(() => {
      calls.push('purge');
      return Promise.resolve(0);
    });
    const scheduler = buildScheduler({
      services: servicesWith({ purgeDeleted, reconcile }),
      backend: fakeAgendaBackend(),
    });

    await runJob(scheduler, FEATURE_FLAG_PURGE_JOB);

    // Reconcile BEFORE purge: the purge erases the soft-deleted rows that
    // witness a killed-but-still-declared flag.
    expect(calls).toEqual(['reconcile', 'purge']);
    // Delegates without minting a clock: the service reads `now` from the
    // injected clock, so the handler passes no arguments.
    expect(purgeDeleted).toHaveBeenCalledWith();
  });

  it('the purge handler warns on code/store drift and stays silent without it', async () => {
    const drifting = servicesWith({
      reconcile: () =>
        Promise.resolve({ orphanLive: ['typoName'], killedButDeclared: ['oldGate'] }),
    });
    const { warnings, logger } = recordingLogger();
    const scheduler = buildScheduler({ services: drifting, backend: fakeAgendaBackend(), logger });

    await runJob(scheduler, FEATURE_FLAG_PURGE_JOB);
    expect(warnings).toEqual([
      {
        obj: { job: FEATURE_FLAG_PURGE_JOB, orphanLive: ['typoName'], killedButDeclared: ['oldGate'] },
        msg: 'feature-flag code/store drift',
      },
    ]);

    const clean = recordingLogger();
    const quiet = buildScheduler({
      services: servicesWith({}),
      backend: fakeAgendaBackend(),
      logger: clean.logger,
    });
    await runJob(quiet, FEATURE_FLAG_PURGE_JOB);
    expect(clean.warnings).toEqual([]);
  });

  it('the point verify handler delegates to the service', async () => {
    const verifyBalances = vi.fn(() => Promise.resolve({ usersChecked: 0 }));
    const scheduler = buildScheduler({
      services: servicesWith({ verifyBalances }),
      backend: fakeAgendaBackend(),
    });

    await runJob(scheduler, POINT_BALANCE_VERIFY_JOB);

    expect(verifyBalances).toHaveBeenCalledOnce();
  });
});
