import type { LedgerService } from '../ledger.service.js';
import { defineJob, type JobRegistrar } from '../../../scheduler/job.js';

/** Sweeps lot remainders that have passed their deadline in a wallet. */
export const LEDGER_LOT_EXPIRE_JOB = 'ledger:lot:expire';
/** Closes flows that were opened and never used. */
export const LEDGER_REFERENCE_VOID_STALE_JOB = 'ledger:reference:void-stale';
/** Recomputes each currency's supply from the log and compares it to balances. */
export const LEDGER_BALANCE_TRIAL_JOB = 'ledger:balance:trial';

/**
 * The ledger's scheduled delivery — three sweeps, each as thin as a route: it
 * delegates the decision and the write to the service, which reads `now` from
 * the injected clock (time enters through that seam, not the handler).
 *
 * The three divide cleanly by what they are for. Expiry MOVES money and so runs
 * as a posting like any other. Voiding is bookkeeping on flows that never held
 * money. The trial balance writes NOTHING — it is defence in depth, the
 * standing proof that the derived balances still describe the append-only log,
 * and it fails loudly rather than repairing what it finds.
 */
export const registerLedgerJobs: JobRegistrar<LedgerService> = (agenda, service) => {
  defineJob(agenda, LEDGER_LOT_EXPIRE_JOB, async () => {
    await service.expireDueLots();
  });

  defineJob(agenda, LEDGER_REFERENCE_VOID_STALE_JOB, async () => {
    await service.voidStaleReferences();
  });

  defineJob(agenda, LEDGER_BALANCE_TRIAL_JOB, async () => {
    await service.verifyTrialBalance();
  });

  return [
    // Daily, in the small hours: expiry is a deadline in days, so running it
    // more often buys nothing and holds a large transaction more often. Pinned
    // to the business's timezone — "the day a lot dies" is a date someone was
    // shown, so the sweep must not drift by an hour when the server moves.
    { name: LEDGER_LOT_EXPIRE_JOB, interval: '0 4 * * *', options: { timezone: 'Asia/Seoul' } },
    // Every ten minutes: an abandoned checkout should stop looking payable
    // quickly, and the sweep is a single guarded statement.
    { name: LEDGER_REFERENCE_VOID_STALE_JOB, interval: '10 minutes' },
    // Hourly: frequent enough that drift is caught within one shift, cheap
    // because both sides are aggregates, and lock-free so it never blocks a
    // movement.
    { name: LEDGER_BALANCE_TRIAL_JOB, interval: '1 hour' },
  ];
};
