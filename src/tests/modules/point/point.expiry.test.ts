import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EXPIRE_AFTER_DAYS, planExpiry } from '../../../modules/point/point.core.js';
import { createPointService } from '../../../modules/point/point.service.js';
import * as pointRepo from '../../../modules/point/point.write.repo.js';
import { addDays, kstEndOfDay } from '../../../foundation/time.js';
import { ConcurrentUpdateError } from '../../../foundation/errors.js';
import { fixedClock } from '../../support/clock.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

// Point expiry against the real (PGlite) database — the worked example of the
// time seam (CONVENTIONS §10). The service's clock is FIXED at NOW, so "which
// charges are past their deadline" is decided against a known instant instead of
// the wall clock at test time. Rows are seeded with EXPLICIT chargedAt values
// relative to NOW (no real-time offsets), so the suite is deterministic whenever
// it runs — the point of injecting the clock rather than freezing a global.
const prisma = await makeTestPrisma();
const NOW = new Date('2026-07-01T00:00:00.000Z');
const points = createPointService({ rw: prisma, ro: prisma }, fixedClock(NOW));

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

let userSeq = 0;
async function makeUser(): Promise<number> {
  const user = await prisma.user.create({ data: { email: `expire-${userSeq++}@example.com` } });
  return user.id;
}

/** Seeds one USABLE charge with an explicit chargedAt, plus the matching balance. */
async function seedCharge(
  userId: number,
  { paid, free, chargedAt }: { paid: number; free: number; chargedAt: Date },
): Promise<void> {
  await prisma.pointCharge.create({
    data: {
      userId,
      paidAmount: paid,
      freeAmount: free,
      unspentPaidAmount: paid,
      unspentFreeAmount: free,
      chargedAt,
    },
  });
  await prisma.pointBalance.upsert({
    where: { userId },
    create: { userId, paidAmount: paid, freeAmount: free, totalAmount: paid + free },
    update: {
      paidAmount: { increment: paid },
      freeAmount: { increment: free },
      totalAmount: { increment: paid + free },
    },
  });
}

describe('PointService.expire (clock-driven path)', () => {
  it('expires a charge past its deadline, zeroing its remainder and the balance', async () => {
    const userId = await makeUser();
    await seedCharge(userId, { paid: 100, free: 30, chargedAt: addDays(NOW, -(EXPIRE_AFTER_DAYS + 2)) });

    // No `now` argument → the injected clock (NOW) supplies it.
    const { expiredCount } = await points.expire(userId);
    expect(expiredCount).toBe(1);

    const charge = await prisma.pointCharge.findFirstOrThrow({ where: { userId } });
    expect(charge).toMatchObject({ state: 'EXPIRED', unspentPaidAmount: 0, unspentFreeAmount: 0 });
    // The domain timestamp is the plan's `now`, NOT a DB default.
    expect(charge.expiredAt?.toISOString()).toBe(NOW.toISOString());

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId } });
    expect(balance).toMatchObject({ paidAmount: 0, freeAmount: 0, totalAmount: 0 });
  });

  it('leaves a charge still within its deadline untouched (inert plan, no writes)', async () => {
    const userId = await makeUser();
    await seedCharge(userId, { paid: 50, free: 0, chargedAt: addDays(NOW, -10) });

    const { expiredCount } = await points.expire(userId);
    expect(expiredCount).toBe(0);

    const charge = await prisma.pointCharge.findFirstOrThrow({ where: { userId } });
    expect(charge.state).toBe('USABLE');
    expect(charge.expiredAt).toBeNull();
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId } });
    expect(balance.totalAmount).toBe(50);
  });

  it('expires only the due charges in a mixed ledger', async () => {
    const userId = await makeUser();
    await seedCharge(userId, { paid: 100, free: 0, chargedAt: addDays(NOW, -(EXPIRE_AFTER_DAYS + 1)) });
    await seedCharge(userId, { paid: 0, free: 40, chargedAt: addDays(NOW, -5) });

    const { expiredCount } = await points.expire(userId);
    expect(expiredCount).toBe(1);

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId } });
    expect(balance).toMatchObject({ paidAmount: 0, freeAmount: 40, totalAmount: 40 });
    expect(await prisma.pointCharge.count({ where: { userId, state: 'USABLE' } })).toBe(1);
    expect(await prisma.pointCharge.count({ where: { userId, state: 'EXPIRED' } })).toBe(1);
  });

  it('expires exactly when now reaches the end of the KST deadline day (boundary)', async () => {
    const userId = await makeUser();
    const chargedAt = addDays(NOW, -EXPIRE_AFTER_DAYS);
    await seedCharge(userId, { paid: 10, free: 0, chargedAt });
    // The deadline is computed the same way planExpiry does.
    const deadline = kstEndOfDay(addDays(chargedAt, EXPIRE_AFTER_DAYS));

    // One millisecond before the deadline → not yet due.
    const before = createPointService(
      { rw: prisma, ro: prisma },
      fixedClock(new Date(deadline.getTime() - 1)),
    );
    expect((await before.expire(userId)).expiredCount).toBe(0);

    // Exactly at the deadline → due (the bound is inclusive).
    const at = createPointService({ rw: prisma, ro: prisma }, fixedClock(deadline));
    expect((await at.expire(userId)).expiredCount).toBe(1);
  });
});

describe('PointService.expire (explicit-now / backfill path)', () => {
  it('uses opts.now instead of the clock, so a re-run at an earlier instant expires nothing', async () => {
    const userId = await makeUser();
    const chargedAt = addDays(NOW, -(EXPIRE_AFTER_DAYS + 1));
    await seedCharge(userId, { paid: 100, free: 0, chargedAt });

    // The service clock (NOW) WOULD expire it; an explicit `now` on the charge
    // day (before the deadline) must not.
    const { expiredCount } = await points.expire(userId, { now: chargedAt });
    expect(expiredCount).toBe(0);
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId } });
    expect(balance.totalAmount).toBe(100);
  });
});

describe('PointService.expire (concurrency)', () => {
  it('rolls back the whole sweep when a charge changed after the world was read (lost race)', async () => {
    const userId = await makeUser();
    await seedCharge(userId, { paid: 100, free: 0, chargedAt: addDays(NOW, -(EXPIRE_AFTER_DAYS + 1)) });

    // Decide an expiry plan on a snapshot of the world…
    const world = await pointRepo.loadExpiryWorld(prisma, userId);
    const plan = planExpiry(world, NOW);

    // …then lose the race: a concurrent spend consumes part of the charge first.
    await points.spend(userId, { amount: 40, reason: 'rival' });

    // Executing the stale plan must fail its guard and write NOTHING.
    await expect(
      prisma.$transaction((tx) => pointRepo.applyExpiryPlan(tx, userId, plan)),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);

    const charge = await prisma.pointCharge.findFirstOrThrow({ where: { userId } });
    expect(charge.state).toBe('USABLE'); // untouched by the stale plan
    expect(charge.expiredAt).toBeNull();
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId } });
    expect(balance.totalAmount).toBe(60); // only the rival spend landed
  });
});
