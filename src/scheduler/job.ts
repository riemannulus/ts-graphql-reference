import type { Agenda } from 'agenda';
import type { SchedulerLogger } from './agenda.js';

/**
 * Defines an async job handler on agenda. agenda's `define` is overloaded — a
 * callback form `(job, done) => void` and a promise form `(job) => Promise<void>`
 * — and an `async` handler is assignable to BOTH, so TS resolves to the FIRST
 * (callback) overload and every direct `agenda.define(name, async …)` trips
 * `no-misused-promises`. agenda inspects the handler and awaits a returned
 * promise at runtime, so the warning is a false positive; it is suppressed ONCE
 * here (the `uow`-style single choke point) instead of at every job site, and
 * job modules call this thin wrapper to keep their handlers clean.
 */
export function defineJob(agenda: Agenda, name: string, handler: () => Promise<void>): void {
  // eslint-disable-next-line typescript/no-misused-promises -- agenda awaits the returned promise (promise-style handler)
  agenda.define(name, handler);
}

/**
 * Scheduler machinery — the `flags/flags.ts` analogue for background jobs: the
 * fixed types every job module speaks, kept apart from the assembly
 * (`scheduler.ts`) and the driver (`agenda.ts`) so a job module depends only on
 * THIS file, never on the assembly that consumes it (which would be a cycle).
 *
 * A job module is a DELIVERY layer — the third kind beside `schemas/` (GraphQL)
 * and `routes/` (HTTP), see CONVENTIONS §5. Its registrar DEFINES the handlers
 * on the shared Agenda (synchronously) and RETURNS its recurring schedules as
 * DATA. Returning the schedule as data (not calling `agenda.every()` itself)
 * means the schedules are inspectable and snapshot-testable without a running
 * backend, and every `every()` call is applied in ONE place (scheduler.start),
 * the way each module's GraphQL fields are appended by one `registerXxxModule()`
 * and every `every()` in crepe lives in one `tasks/index.ts`.
 */

/** The subset of agenda's `every()` options a recurring schedule may carry. */
export interface EveryOptions {
  /** IANA timezone the cron expression is evaluated in (default: server local). */
  timezone?: string;
  /** Skip the immediate run agenda would otherwise perform on (re)scheduling. */
  skipImmediate?: boolean;
}

/** One recurring schedule a job module contributes — an `agenda.every()` spec. */
export interface JobSchedule {
  /** The job name, `domain:action` (e.g. `feature-flag:purge-deleted`). */
  name: string;
  /** A cron expression or human interval (e.g. `'0 3 * * *'`, `'15 minutes'`). */
  interval: string;
  /** Forwarded to `agenda.every()`. */
  options?: EveryOptions;
}

/**
 * A job module's registrar: DEFINE the handlers on `agenda`, RETURN the
 * schedules to apply. `Service` is the ONE domain dependency it receives — its
 * own module's service, injected at assembly time — never a db handle, exactly
 * as an HTTP route receives its service at registration (`registerGoogleOAuth`).
 * The optional `logger` is the delivery layer's observability port (the same
 * sink agenda's lifecycle events use; an HTTP route has `app.log` the same way)
 * for a handler whose OUTPUT is a report rather than a write — a registrar that
 * only delegates writes ignores it. The handler stays thin: it delegates the
 * decision + write to the service.
 */
export type JobRegistrar<Service> = (
  agenda: Agenda,
  service: Service,
  logger?: SchedulerLogger,
) => JobSchedule[];
