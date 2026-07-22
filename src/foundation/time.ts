import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

/**
 * Time — the pure calendar module, and the codebase's SINGLE date-library seam.
 *
 * Everything that reasons about instants as CALENDAR values — a day boundary in
 * the business zone, adding days, (later) formatting or durations — lives behind
 * these pure functions, and this is the ONLY file allowed to import a date
 * library (enforced by dependency-cruiser's `dayjs-lives-in-time-only`). That is
 * the whole point for the crepe migration: crepe imports dayjs in ~80 files and
 * monkey-patches its prototype (`lib/dayjs.ts` adds `.kst()`, `.formatAsDate()`,
 * …); the refactor collapses all of that to this one wrapper of plain functions,
 * so a later swap (dayjs → Temporal) is a one-file change and no call site knows
 * — or needs to know — which library computed a calendar answer.
 *
 * A `Dayjs` value never crosses this module's interface: the functions take and
 * return plain `Date` (an instant), exactly as a Prisma row never crosses a
 * repo's interface. A core file MAY import this module — it is pure, no I/O, like
 * `foundation/errors.ts` — and does its day-math here; it may NOT import
 * `clock.ts`, because reading "now" is an effect that belongs to the shell.
 *
 * ## Why fixed-offset arithmetic, not `dayjs.tz('Asia/Seoul')`
 *
 * KST is a FIXED offset (UTC+9, no DST), so a KST day boundary is a pure function
 * of the instant. We compute it by shifting into UTC-mode by +9h, taking the UTC
 * calendar boundary, and shifting back — deliberately NOT `dayjs(i).tz('Asia/
 * Seoul').endOf('day')`. dayjs's tz/`endOf` machinery consults the SERVER's local
 * zone and mis-derives the boundary by an hour when the process TZ is mid its own
 * DST transition (a charge's expiry then flips with `process.env.TZ` — a real
 * regression this module was reviewed to have). Staying in `dayjs.utc()` mode and
 * adding a fixed offset touches no local-zone table, so the result is identical
 * under any deploy TZ (verified in `time.test.ts` against a pure-arithmetic
 * oracle). A DST-BEARING business zone would need genuine per-instant offset
 * resolution (and a tz library that gets it right) — that logic would live HERE,
 * behind the same interface, changing no caller.
 */
dayjs.extend(utc);

/** The business timezone's IANA identity — for logging/display. The day-boundary
 * math uses the fixed offset below, since the zone observes no DST. */
export const KST_TIME_ZONE = 'Asia/Seoul';

/** KST's fixed UTC offset in hours (UTC+9). The single source for the shift. */
export const KST_UTC_OFFSET_HOURS = 9;

/**
 * The instant `days` calendar days after `instant`. Computed in UTC mode, where a
 * "day" is exactly 24h (UTC has no DST) — so the result is an exact instant
 * offset, independent of the server's timezone. For a fixed-offset business zone
 * this equals "the same wall-clock time, `days` later".
 */
export function addDays(instant: Date, days: number): Date {
  return dayjs.utc(instant).add(days, 'day').toDate();
}

/**
 * The last instant of the KST calendar day that contains `instant`
 * (23:59:59.999 at UTC+9). An inclusive, day-granular deadline: a thing dated
 * within a KST day is still "in time" until this instant passes. Zone-independent
 * (see the module docstring): shift +9h into UTC mode, take the UTC end-of-day,
 * shift back.
 */
export function kstEndOfDay(instant: Date): Date {
  return dayjs
    .utc(instant)
    .add(KST_UTC_OFFSET_HOURS, 'hour')
    .endOf('day')
    .subtract(KST_UTC_OFFSET_HOURS, 'hour')
    .toDate();
}
