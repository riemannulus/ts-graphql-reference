import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { addDays, kstCalendarDate, kstEndOfDay, KST_TIME_ZONE, KST_UTC_OFFSET_HOURS } from '../../foundation/time.js';

// A pure-arithmetic oracle for "end of the KST day", independent of dayjs: shift
// +9h into UTC-wall-ms, floor to the UTC day, take that day's last ms, shift back.
// If the implementation ever regresses to a local-zone-dependent form (e.g. back
// to dayjs.tz().endOf()), this diverges under a DST-observing CI timezone.
function kstEndOfDayOracle(instant: Date): number {
  const offset = KST_UTC_OFFSET_HOURS * 3_600_000;
  const kstWallMs = instant.getTime() + offset;
  const kstDayStart = Math.floor(kstWallMs / 86_400_000) * 86_400_000;
  return kstDayStart + 86_400_000 - 1 - offset;
}

// The pure calendar seam. These pin the ONE thing a raw `Date` gets wrong —
// where a *day* begins and ends in Asia/Seoul (UTC+9) — so the rest of the
// codebase can reason in instants and defer day-math to here.

describe('time.KST_TIME_ZONE', () => {
  it('is the single-sourced business timezone', () => {
    expect(KST_TIME_ZONE).toBe('Asia/Seoul');
  });
});

describe('time.kstEndOfDay', () => {
  it('returns 23:59:59.999 Asia/Seoul of the KST day containing the instant', () => {
    // 2026-01-15T20:00:00Z is 2026-01-16 05:00 KST → end of KST day 01-16.
    expect(kstEndOfDay(new Date('2026-01-15T20:00:00Z')).toISOString()).toBe(
      '2026-01-16T14:59:59.999Z',
    );
  });

  it('keeps an instant already late in the KST day within that same day', () => {
    // 2026-01-16T14:00:00Z is 2026-01-16 23:00 KST → same KST day end.
    expect(kstEndOfDay(new Date('2026-01-16T14:00:00Z')).toISOString()).toBe(
      '2026-01-16T14:59:59.999Z',
    );
  });

  it('rolls to the next KST day just after KST midnight (the UTC-vs-KST trap)', () => {
    // 2026-01-16T15:00:00Z is 2026-01-17 00:00 KST — a naive UTC endOf-day would
    // still say the 16th; in KST it is already the 17th.
    expect(kstEndOfDay(new Date('2026-01-16T15:00:00Z')).toISOString()).toBe(
      '2026-01-17T14:59:59.999Z',
    );
  });

  it('is idempotent: the end of the day of the end of the day is the same instant', () => {
    const once = kstEndOfDay(new Date('2026-03-01T12:00:00Z'));
    expect(kstEndOfDay(once).toISOString()).toBe(once.toISOString());
  });

  // Zone-independence regression guard. dayjs's tz/endOf machinery mis-derives a
  // fixed-offset boundary by an hour when the SERVER's process TZ is mid its own
  // DST transition; these instants land on/around the 2025-03-09 US spring-forward,
  // where the buggy `.tz('Asia/Seoul').endOf('day')` returns 13:59:59.999Z under
  // TZ=America/New_York instead of the correct 14:59:59.999Z. The fixed-offset
  // implementation returns the same instant under ANY deploy TZ. These are absolute
  // instants, so run the suite under `TZ=America/New_York` in CI to lock it in.
  it('is unaffected by a server DST transition (fixed-offset, not tz-database)', () => {
    // 2025-03-08T15:00Z = 2025-03-09 00:00 KST → end of KST day 03-09.
    expect(kstEndOfDay(new Date('2025-03-08T15:00:00Z')).toISOString()).toBe(
      '2025-03-09T14:59:59.999Z',
    );
    // 2025-03-09T06:30Z = 2025-03-09 15:30 KST → same KST day end.
    expect(kstEndOfDay(new Date('2025-03-09T06:30:00Z')).toISOString()).toBe(
      '2025-03-09T14:59:59.999Z',
    );
  });

  test.prop([
    fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
  ])('matches a pure-arithmetic KST-end-of-day oracle for every instant', (instant) => {
    expect(kstEndOfDay(instant).getTime()).toBe(kstEndOfDayOracle(instant));
  });
});

describe('time.kstCalendarDate', () => {
  it('names the KST day containing the instant (the UTC-vs-KST trap)', () => {
    // 2026-01-16T15:00:00Z is already 2026-01-17 00:00 KST.
    expect(kstCalendarDate(new Date('2026-01-16T15:00:00Z'))).toBe('2026-01-17');
    expect(kstCalendarDate(new Date('2026-01-16T14:59:59.999Z'))).toBe('2026-01-16');
  });

  test.prop([
    fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
  ])('agrees with kstEndOfDay: every instant shares its day-name with its day-end', (instant) => {
    expect(kstCalendarDate(kstEndOfDay(instant))).toBe(kstCalendarDate(instant));
    // ...and the next millisecond starts the next day.
    expect(kstCalendarDate(new Date(kstEndOfDay(instant).getTime() + 1))).not.toBe(
      kstCalendarDate(instant),
    );
  });
});

describe('time.addDays', () => {
  it('adds calendar days as an instant offset', () => {
    expect(addDays(new Date('2026-01-15T20:00:00Z'), 3).toISOString()).toBe(
      '2026-01-18T20:00:00.000Z',
    );
  });

  test.prop([fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }), fc.integer({ min: -3650, max: 3650 })])(
    'is inverse under negation',
    (instant, days) => {
      expect(addDays(addDays(instant, days), -days).getTime()).toBe(instant.getTime());
    },
  );
});
