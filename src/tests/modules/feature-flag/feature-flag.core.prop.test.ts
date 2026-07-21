import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  InvalidFlagWindowError,
  isActive,
  parseStage,
  planFlagUpsert,
  STAGES,
  UnknownFlagStageError,
} from '../../../modules/feature-flag/feature-flag.core.js';
import { arbFlagRow, arbInstant, arbStage } from './feature-flag.arbitraries.js';

// isActive is the crepe activation rule as a pure predicate — its laws are
// provable with no database. Each guard is NECESSARY (violate it → inactive) and
// together the guards are SUFFICIENT (all satisfied → active). Totality: it
// returns a boolean for every input, including corrupt rows.

test.prop([arbFlagRow, arbStage, arbInstant])('is total — always a boolean', (row, stage, now) => {
  expect(typeof isActive(row, stage, now)).toBe('boolean');
});

test.prop([arbFlagRow, arbStage, arbInstant])('a soft-deleted flag is never active', (row, stage, now) => {
  fc.pre(row.deletedAt !== null);
  expect(isActive(row, stage, now)).toBe(false);
});

test.prop([arbFlagRow, arbStage, arbInstant])(
  'a flag whose stage is not the deploy stage is never active',
  (row, stage, now) => {
    fc.pre(parseStage(row.stage) !== stage);
    expect(isActive(row, stage, now)).toBe(false);
  },
);

test.prop([arbFlagRow, arbStage, arbInstant])(
  'a flag with no enableAfter is never active',
  (row, stage, now) => {
    fc.pre(row.enableAfter === null);
    expect(isActive(row, stage, now)).toBe(false);
  },
);

test.prop([
  arbStage,
  arbInstant,
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null }),
])('an in-stage, live, in-window flag is active (sufficiency)', (stage, now, enabledAgo, disableIn) => {
  const row = {
    stage,
    enableAfter: new Date(now.getTime() - enabledAgo),
    disableAfter: disableIn === null ? null : new Date(now.getTime() + disableIn),
    deletedAt: null,
  };
  expect(isActive(row, stage, now)).toBe(true);
});

test.prop([arbStage, arbInstant, fc.integer({ min: 1, max: 1_000_000 })])(
  'a flag whose enableAfter is still in the future is not yet active',
  (stage, now, ahead) => {
    const row = { stage, enableAfter: new Date(now.getTime() + ahead), disableAfter: null, deletedAt: null };
    expect(isActive(row, stage, now)).toBe(false);
  },
);

test.prop([
  arbStage,
  arbInstant,
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: 0, max: 1_000_000 }),
])('a flag whose disableAfter has passed is no longer active', (stage, now, past, window) => {
  const disableAfter = new Date(now.getTime() - past);
  const row = {
    stage,
    enableAfter: new Date(disableAfter.getTime() - window), // enableAfter <= disableAfter (window CHECK)
    disableAfter,
    deletedAt: null,
  };
  expect(isActive(row, stage, now)).toBe(false);
});

describe('isActive window boundaries (inclusive)', () => {
  const now = new Date(1_700_000_000_000);
  it('is active when enableAfter equals now', () => {
    expect(isActive({ stage: 'PROD', enableAfter: now, disableAfter: null, deletedAt: null }, 'PROD', now)).toBe(true);
  });
  it('is active when disableAfter equals now', () => {
    expect(
      isActive({ stage: 'PROD', enableAfter: now, disableAfter: now, deletedAt: null }, 'PROD', now),
    ).toBe(true);
  });
});

describe('parseStage — parse, do not validate', () => {
  it('accepts every known stage unchanged', () => {
    for (const stage of STAGES) expect(parseStage(stage)).toBe(stage);
  });
  it('returns null for unknown / mis-cased / empty / null / undefined', () => {
    expect(parseStage('prod')).toBeNull();
    expect(parseStage('Prod')).toBeNull();
    expect(parseStage('STAGING')).toBeNull();
    expect(parseStage('')).toBeNull();
    expect(parseStage(null)).toBeNull();
    expect(parseStage(undefined)).toBeNull();
  });
});

describe('planFlagUpsert', () => {
  const base = {
    name: 'f',
    description: null as string | null,
    stage: 'PROD' as string | null,
    value: null as string | null,
    enableAfter: null as Date | null,
    disableAfter: null as Date | null,
  };
  it('returns the write for a valid input', () => {
    expect(planFlagUpsert(base)).toEqual(base);
  });
  it('allows a null stage (a never-active row)', () => {
    expect(planFlagUpsert({ ...base, stage: null }).stage).toBeNull();
  });
  it('rejects an unknown stage', () => {
    expect(() => planFlagUpsert({ ...base, stage: 'STAGING' })).toThrow(UnknownFlagStageError);
  });
  it('rejects a window that ends before it starts', () => {
    const t = 1_700_000_000_000;
    expect(() =>
      planFlagUpsert({ ...base, enableAfter: new Date(t + 1000), disableAfter: new Date(t) }),
    ).toThrow(InvalidFlagWindowError);
  });
  it('allows a window with only one bound set', () => {
    expect(() => planFlagUpsert({ ...base, enableAfter: new Date(1_700_000_000_000), disableAfter: null })).not.toThrow();
  });
  it('allows an equal-bounds (instantaneous) window — the bound is inclusive', () => {
    const t = new Date(1_700_000_000_000);
    expect(() => planFlagUpsert({ ...base, enableAfter: t, disableAfter: t })).not.toThrow();
  });
});
