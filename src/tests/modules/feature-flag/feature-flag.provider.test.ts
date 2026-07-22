import { StandardResolutionReasons } from '@openfeature/server-sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbFeatureFlagProvider } from '../../../modules/feature-flag/feature-flag.provider.js';
import { fixedClock } from '../../support/clock.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

// The crepe evaluation rule against the real (PGlite) database, through the
// OpenFeature Provider port. The pure predicate is unit-tested in
// feature-flag.core.prop.test.ts; here we prove the provider reads the right row
// and maps it to the right ResolutionDetails.
const prisma = await makeTestPrisma();
beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

// A FIXED evaluation instant, injected as the provider's clock — so "is this
// flag's window active" is decided against a known `now`, not the wall clock at
// test time (which would make a window test flaky near its own boundary). The
// window bounds are expressed relative to this same NOW.
const NOW = new Date('2026-06-15T00:00:00.000Z');
const clock = fixedClock(NOW);
const past = new Date(NOW.getTime() - 60_000);
const future = new Date(NOW.getTime() + 60_000);

describe('DbFeatureFlagProvider.resolveBooleanEvaluation', () => {
  it('returns the caller default (reason DEFAULT) when no row exists', async () => {
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveBooleanEvaluation('missing', false)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.DEFAULT,
    });
    expect(await provider.resolveBooleanEvaluation('missing', true)).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.DEFAULT,
    });
  });

  it('activates an in-stage, in-window, live flag (reason TARGETING_MATCH)', async () => {
    await prisma.featureFlag.create({ data: { name: 'f', stage: 'PROD', enableAfter: past } });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveBooleanEvaluation('f', false)).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.TARGETING_MATCH,
    });
  });

  it('activates a flag inside an ordered [past, future] window (the scheduled-window feature)', async () => {
    await prisma.featureFlag.create({
      data: { name: 'f', stage: 'PROD', enableAfter: past, disableAfter: future },
    });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveBooleanEvaluation('f', false)).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.TARGETING_MATCH,
    });
  });

  it('reports a present-but-inactive flag as DISABLED (value false, ignoring the default)', async () => {
    await prisma.featureFlag.create({ data: { name: 'f', stage: 'PROD', enableAfter: future } });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveBooleanEvaluation('f', true)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.DISABLED,
    });
  });

  it('does not activate a flag registered for a different stage', async () => {
    await prisma.featureFlag.create({ data: { name: 'f', stage: 'DEV', enableAfter: past } });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect((await provider.resolveBooleanEvaluation('f', false)).value).toBe(false);
  });

  it('never sees a soft-deleted flag (falls back to the default)', async () => {
    await prisma.featureFlag.create({
      data: { name: 'f', stage: 'PROD', enableAfter: past, deletedAt: NOW },
    });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveBooleanEvaluation('f', false)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.DEFAULT,
    });
  });

  it('treats a flag whose disableAfter has passed as expired', async () => {
    await prisma.featureFlag.create({
      data: { name: 'f', stage: 'PROD', enableAfter: new Date(NOW.getTime() - 120_000), disableAfter: past },
    });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect((await provider.resolveBooleanEvaluation('f', false)).value).toBe(false);
  });

  it('fails safe (default, reason ERROR) when the deploy stage is unset', async () => {
    await prisma.featureFlag.create({ data: { name: 'f', stage: 'PROD', enableAfter: past } });
    const provider = new DbFeatureFlagProvider(prisma, null, clock);
    expect(await provider.resolveBooleanEvaluation('f', false)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
    });
  });
});

describe('DbFeatureFlagProvider.resolveStringEvaluation (the variant payload)', () => {
  it('returns the active flag value column (reason TARGETING_MATCH)', async () => {
    await prisma.featureFlag.create({
      data: { name: 'welcomeVariant', stage: 'PROD', enableAfter: past, value: 'festive' },
    });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect(await provider.resolveStringEvaluation('welcomeVariant', 'classic')).toMatchObject({
      value: 'festive',
      reason: StandardResolutionReasons.TARGETING_MATCH,
    });
  });

  it('returns the default when the flag is inactive or has no value', async () => {
    // inactive (future window) — even though a value is set
    await prisma.featureFlag.create({
      data: { name: 'a', stage: 'PROD', enableAfter: future, value: 'festive' },
    });
    // active but no value column
    await prisma.featureFlag.create({ data: { name: 'b', stage: 'PROD', enableAfter: past } });
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect((await provider.resolveStringEvaluation('a', 'classic')).value).toBe('classic');
    expect((await provider.resolveStringEvaluation('b', 'classic')).value).toBe('classic');
    expect((await provider.resolveStringEvaluation('missing', 'classic')).value).toBe('classic');
  });
});

describe('DbFeatureFlagProvider — number / object resolutions pass through the default', () => {
  it('return the caller default (the crepe model carries no numeric/JSON payload)', async () => {
    const provider = new DbFeatureFlagProvider(prisma, 'PROD', clock);
    expect((await provider.resolveNumberEvaluation('f', 7)).value).toBe(7);
    expect((await provider.resolveObjectEvaluation('f', { a: 1 })).value).toEqual({ a: 1 });
  });
});
