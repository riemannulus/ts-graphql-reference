import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPointService } from '../../../modules/point/point.service.js';
import {
  InsufficientPointError,
  PointAmountNotPositiveError,
  planSpend,
} from '../../../modules/point/point.core.js';
import * as pointRepo from '../../../modules/point/point.repo.js';
import { ConcurrentUpdateError } from '../../../errors.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const points = createPointService({ rw: prisma, ro: prisma });

async function makeUser() {
  return prisma.user.create({ data: { email: 'points@example.com' } });
}

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('PointService.charge', () => {
  it('creates a USABLE charge and initializes the balance', async () => {
    const user = await makeUser();
    const charge = await points.charge(user.id, { paidAmount: 100, freeAmount: 30 });

    expect(charge.state).toBe('USABLE');
    expect(charge.unspentPaidAmount).toBe(100);
    expect(charge.unspentFreeAmount).toBe(30);

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance).toMatchObject({ paidAmount: 100, freeAmount: 30, totalAmount: 130 });
  });

  it('accumulates the balance across charges', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });
    await points.charge(user.id, { paidAmount: 0, freeAmount: 50 });

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance).toMatchObject({ paidAmount: 100, freeAmount: 50, totalAmount: 150 });
  });

  it('rejects an empty top-up', async () => {
    const user = await makeUser();
    await expect(points.charge(user.id, { paidAmount: 0, freeAmount: 0 })).rejects.toBeInstanceOf(
      PointAmountNotPositiveError,
    );
  });
});

describe('PointService.spend', () => {
  it('spends paid-first, FIFO across charges, and records the split', async () => {
    const user = await makeUser();
    const first = await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });
    const second = await points.charge(user.id, { paidAmount: 50, freeAmount: 100 });

    const spend = await points.spend(user.id, { amount: 200, reason: 'checkout' });
    expect(spend).toMatchObject({ paidAmount: 150, freeAmount: 50, totalAmount: 200 });

    // First (older) charge fully consumed, second partially.
    const firstAfter = await prisma.pointCharge.findUniqueOrThrow({ where: { id: first.id } });
    expect(firstAfter).toMatchObject({ state: 'CONSUMED', unspentPaidAmount: 0 });
    const secondAfter = await prisma.pointCharge.findUniqueOrThrow({ where: { id: second.id } });
    expect(secondAfter).toMatchObject({
      state: 'USABLE',
      unspentPaidAmount: 0,
      unspentFreeAmount: 50,
    });

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance).toMatchObject({ paidAmount: 0, freeAmount: 50, totalAmount: 50 });
  });

  it('rejects a spend beyond the balance without writing anything', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 10, freeAmount: 0 });

    await expect(points.spend(user.id, { amount: 11, reason: 'x' })).rejects.toBeInstanceOf(
      InsufficientPointError,
    );
    expect(await prisma.pointSpend.count()).toBe(0);
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance.totalAmount).toBe(10);
  });

  it('rejects a spend for a user with no balance row at all', async () => {
    const user = await makeUser();
    await expect(points.spend(user.id, { amount: 1, reason: 'x' })).rejects.toBeInstanceOf(
      InsufficientPointError,
    );
  });

  it('rolls back the whole spend when a plan assumption no longer holds (lost race)', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });

    // Decide on a snapshot of the world…
    const world = await pointRepo.loadSpendWorld(prisma, user.id);
    const plan = planSpend(world.snapshot, world.charges, 60);

    // …then lose the race: a concurrent spend consumes points first.
    await points.spend(user.id, { amount: 50, reason: 'rival' });

    // Executing the stale plan must fail its guards and write NOTHING.
    await expect(
      prisma.$transaction((tx) => pointRepo.applySpendPlan(tx, user.id, 'stale', plan)),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);

    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance.totalAmount).toBe(50); // only the rival spend landed
    expect(await prisma.pointSpend.count()).toBe(1);
  });
});
