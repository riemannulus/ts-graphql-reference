import { describe, expect, it } from 'vitest';
import { FLAGS } from '../../flags/flag-registry.js';
import {
  expiredFlags,
  gate,
  isIsoCalendarDate,
  permanent,
  temporary,
  variant,
} from '../../flags/flags.js';
import { kstCalendarDate } from '../../foundation/time.js';

// The code-level purge, enforced. The DB half of a flag's life is swept by the
// `feature-flag:purge-deleted` job; this file is the counterpart for the CODE
// half: a `temporary(removeBy)` registry entry that outlives its deadline fails
// the build here, and deleting the entry turns every call site into a compile
// error — the compiler finishes what the deadline starts. The machinery is
// proven on fixture specs with `today` as fixed data (this module reads no
// clock); only the final guard reads the real date, because being a time bomb
// is its entire job.

describe('temporary()', () => {
  it('accepts an ISO calendar date', () => {
    expect(temporary('2030-12-31')).toEqual({ kind: 'temporary', removeBy: '2030-12-31' });
  });

  it('rejects malformed or impossible dates at construction (registry load fails fast)', () => {
    for (const bad of ['soon', '2030-1-1', '20301231', '2030-13-01', '2030-00-10', '2030-04-31', '2030-02-30', '']) {
      expect(() => temporary(bad), bad).toThrow(/ISO calendar date/);
    }
  });

  it('applies the leap-year rule (parse, don’t validate)', () => {
    expect(() => temporary('2028-02-29')).not.toThrow(); // divisible by 4
    expect(() => temporary('2029-02-29')).toThrow(); // common year
    expect(() => temporary('2100-02-29')).toThrow(); // century, not by 400
    expect(() => temporary('2000-02-29')).not.toThrow(); // by 400
  });
});

describe('isIsoCalendarDate', () => {
  it('is a total predicate over strings', () => {
    expect(isIsoCalendarDate('2026-07-28')).toBe(true);
    expect(isIsoCalendarDate('2026-07-32')).toBe(false);
    expect(isIsoCalendarDate('not a date')).toBe(false);
  });
});

describe('expiredFlags', () => {
  const SPECS = {
    killSwitch: gate(false, 'ops kill switch', permanent),
    rollout: gate(false, 'rollout gate', temporary('2026-06-30')),
    experiment: variant(['a', 'b'], 'a', 'an experiment', temporary('2026-07-15')),
  };

  it('never reports a permanent flag', () => {
    expect(expiredFlags({ killSwitch: SPECS.killSwitch }, '2099-12-31')).toEqual([]);
  });

  it('lets a temporary flag live THROUGH its removeBy day', () => {
    expect(expiredFlags(SPECS, '2026-06-30')).toEqual([]);
  });

  it('reports a temporary flag from the day after removeBy', () => {
    expect(expiredFlags(SPECS, '2026-07-01')).toEqual([
      { name: 'rollout', removeBy: '2026-06-30' },
    ]);
  });

  it('reports every overdue flag, in registry order', () => {
    expect(expiredFlags(SPECS, '2026-07-16')).toEqual([
      { name: 'rollout', removeBy: '2026-06-30' },
      { name: 'experiment', removeBy: '2026-07-15' },
    ]);
  });

  it('rejects a malformed today instead of silently expiring nothing', () => {
    expect(() => expiredFlags(SPECS, 'today')).toThrow(/ISO calendar date/);
  });
});

describe('the live registry', () => {
  // THE enforcement point — the one test in the suite that deliberately reads
  // the wall clock, because its assertion is about the real today. When it
  // fails, the fix is not here: delete the named entry from flag-registry.ts
  // (and let the compiler surface every call site), or, if the flag genuinely
  // must live on, extend its removeBy / promote it to `permanent` in review.
  it('contains no temporary flag past its removeBy deadline', () => {
    const today = kstCalendarDate(new Date());
    const expired = expiredFlags(FLAGS, today);
    const instructions = expired
      .map((f) => `"${f.name}" (removeBy ${f.removeBy})`)
      .join(', ');
    expect(
      expired,
      `Overdue feature flag(s): ${instructions}. Delete the entry from src/flags/flag-registry.ts and remove the call sites the compiler then flags — or extend removeBy / promote to permanent if the flag must outlive its deadline.`,
    ).toEqual([]);
  });
});
