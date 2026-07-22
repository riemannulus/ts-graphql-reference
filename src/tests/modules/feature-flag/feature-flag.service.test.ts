import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidFlagWindowError,
  UnknownFlagStageError,
} from '../../../modules/feature-flag/feature-flag.core.js';
import { createFeatureFlagService } from '../../../modules/feature-flag/feature-flag.service.js';
import { systemClock } from '../../../foundation/clock.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

// The admin write side against the test DB: create, in-place update (one live row
// per name), recreate-by-name after a soft delete, soft delete, and the core's
// validation surfacing as domain errors that write nothing.
const prisma = await makeTestPrisma();
const flags = createFeatureFlagService({ rw: prisma, ro: prisma }, systemClock);

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('FeatureFlagService.upsert', () => {
  it('creates a new live flag', async () => {
    const flag = await flags.upsert({ name: 'pointTransfer', stage: 'PROD', enableAfter: new Date() });
    expect(flag).toMatchObject({ name: 'pointTransfer', stage: 'PROD', deletedAt: null });
    expect(await prisma.featureFlag.count()).toBe(1);
  });

  it('updates the existing live row in place instead of creating a second', async () => {
    const first = await flags.upsert({ name: 'x', stage: 'PROD' });
    const second = await flags.upsert({ name: 'x', stage: 'DEV', description: 'now on dev' });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ stage: 'DEV', description: 'now on dev' });
    expect(await prisma.featureFlag.count()).toBe(1);
  });

  it('recreates a name after a soft delete (new live row; the old stays deleted)', async () => {
    const created = await flags.upsert({ name: 'x', stage: 'PROD' });
    await flags.remove(created.id);
    const recreated = await flags.upsert({ name: 'x', stage: 'QA' });

    expect(recreated.id).not.toBe(created.id);
    expect(recreated.deletedAt).toBeNull();
    expect(await prisma.featureFlag.count()).toBe(2); // old (soft-deleted) + new (live)
    expect(await prisma.featureFlag.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('rejects an unknown stage, writing nothing', async () => {
    await expect(flags.upsert({ name: 'x', stage: 'STAGING' })).rejects.toBeInstanceOf(
      UnknownFlagStageError,
    );
    expect(await prisma.featureFlag.count()).toBe(0);
  });

  it('rejects a window that ends before it starts', async () => {
    const t = Date.now();
    await expect(
      flags.upsert({ name: 'x', stage: 'PROD', enableAfter: new Date(t + 1000), disableAfter: new Date(t) }),
    ).rejects.toBeInstanceOf(InvalidFlagWindowError);
    expect(await prisma.featureFlag.count()).toBe(0);
  });
});

describe('FeatureFlagService.remove', () => {
  it('soft-deletes (records deletedAt; the row remains, no longer live)', async () => {
    const flag = await flags.upsert({ name: 'x', stage: 'PROD' });
    const removed = await flags.remove(flag.id);

    expect(removed.deletedAt).not.toBeNull();
    expect(await prisma.featureFlag.count()).toBe(1); // still present…
    expect(await prisma.featureFlag.count({ where: { deletedAt: null } })).toBe(0); // …but not live
  });
});

describe('FeatureFlagService.purgeDeleted', () => {
  // `deletedAt` is set directly here (not via remove(), which stamps `now`) so a
  // row can be aged past the retention window deterministically.
  const now = new Date('2026-07-01T00:00:00Z');

  it('hard-deletes rows soft-deleted before the cutoff, keeping recent + live', async () => {
    await prisma.featureFlag.create({ data: { name: 'live', stage: 'PROD', deletedAt: null } });
    await prisma.featureFlag.create({
      data: { name: 'recent', stage: 'PROD', deletedAt: new Date('2026-06-25T00:00:00Z') }, // ~6 days
    });
    await prisma.featureFlag.create({
      data: { name: 'old', stage: 'PROD', deletedAt: new Date('2026-05-01T00:00:00Z') }, // ~61 days
    });

    const purged = await flags.purgeDeleted({ now });

    expect(purged).toBe(1);
    const names = (await prisma.featureFlag.findMany({ select: { name: true } }))
      .map((f) => f.name)
      .toSorted();
    expect(names).toEqual(['live', 'recent']);
  });

  it('never purges a live row, even with a zero-day retention window', async () => {
    await prisma.featureFlag.create({ data: { name: 'live', stage: 'PROD', deletedAt: null } });

    expect(await flags.purgeDeleted({ now, retentionDays: 0 })).toBe(0);
    expect(await prisma.featureFlag.count()).toBe(1);
  });

  it('respects a custom retention window', async () => {
    await prisma.featureFlag.create({
      data: { name: 'x', stage: 'PROD', deletedAt: new Date('2026-06-20T00:00:00Z') }, // ~11 days
    });

    expect(await flags.purgeDeleted({ now, retentionDays: 30 })).toBe(0); // 11d < 30d → kept
    expect(await flags.purgeDeleted({ now, retentionDays: 7 })).toBe(1); // 11d ≥ 7d → purged
  });
});
