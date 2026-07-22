import type { PointService } from '../point.service.js';
import { defineJob, type JobRegistrar } from '../../../scheduler/job.js';

/** The point-balance consistency sweep — see `PointService.verifyBalances`. */
export const POINT_BALANCE_VERIFY_JOB = 'point:balance:verify';

/**
 * The point module's scheduled delivery. The handler is thin: it delegates to
 * the service, which reads each user's balance + ledger under one snapshot and
 * throws `PointBalanceDriftError` if they disagree — a corruption signal that
 * surfaces through agenda's `fail` event (the crepe clairvoyance balance-check
 * analogue). Read-only defense in depth: in a correct system it finds nothing
 * and simply reports how many users it checked.
 */
export const registerPointJobs: JobRegistrar<PointService> = (agenda, service) => {
  defineJob(agenda, POINT_BALANCE_VERIFY_JOB, async () => {
    await service.verifyBalances();
  });
  // Every 15 minutes — frequent enough to catch drift quickly, cheap (indexed
  // reads under a short snapshot), and lock-free so it never blocks a spend.
  return [{ name: POINT_BALANCE_VERIFY_JOB, interval: '15 minutes' }];
};
