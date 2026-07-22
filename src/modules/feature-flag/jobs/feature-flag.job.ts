import type { FeatureFlagService } from '../feature-flag.service.js';
import { defineJob, type JobRegistrar } from '../../../scheduler/job.js';

/** The soft-deleted-flag cleanup job — see `FeatureFlagService.purgeDeleted`. */
export const FEATURE_FLAG_PURGE_JOB = 'feature-flag:purge-deleted';

/**
 * The feature-flag module's scheduled delivery — a `jobs/*.job.ts` file, the
 * peer of `schemas/` and `routes/`. Like an HTTP route (`registerGoogleOAuth`),
 * the registrar receives its SERVICE, never a db handle, and the handler is
 * THIN: it delegates the retention decision and the delete to the service, which
 * reads `now` from the injected clock (CONVENTIONS §10 — time enters through the
 * clock seam, exactly as a resolver never mints its own `new Date()`). It DEFINES
 * the handler and RETURNS the schedule for `scheduler.ts` to apply.
 */
export const registerFeatureFlagJobs: JobRegistrar<FeatureFlagService> = (agenda, service) => {
  defineJob(agenda, FEATURE_FLAG_PURGE_JOB, async () => {
    await service.purgeDeleted();
  });
  // Daily at 03:00 KST — a low-traffic window for a housekeeping sweep. The
  // timezone is pinned (crepe runs its jobs in KST) so the cron does not drift
  // with the server's local zone; this is where a JobSchedule's options earn
  // their place.
  return [{ name: FEATURE_FLAG_PURGE_JOB, interval: '0 3 * * *', options: { timezone: 'Asia/Seoul' } }];
};
