import type { Clock } from '../../foundation/clock.js';

/**
 * A clock frozen at `instant` — the test seam for the `Clock` port. Inject it via
 * `buildApp({ clock })` / `createServices(db, { clock })` to exercise a
 * time-sensitive use-case deterministically, instead of mutating a process-global
 * with `vi.useFakeTimers` (which freezes only the app clock — the DB's own
 * `now()` keeps running, so the two would disagree; see CONVENTIONS §10).
 *
 * The seam analogue of the OAuth / search fakes and `fakeFlagReader`.
 */
export function fixedClock(instant: Date): Clock {
  return { now: () => instant };
}
