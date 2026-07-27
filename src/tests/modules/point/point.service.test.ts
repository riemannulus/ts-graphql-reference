import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPointService } from '../../../modules/point/point.service.js';
import {
  InsufficientPointError,
  PointAmountNotPositiveError,
  PointBalanceDriftError,
  planSpend,
  PointTransferToSelfError,
} from '../../../modules/point/point.core.js';
import * as pointRepo from '../../../modules/point/point.write.repo.js';
import { systemClock } from '../../../foundation/clock.js';
import { ConcurrentUpdateError, FeatureDisabledError } from '../../../foundation/errors.js';
import { fakeOutbox, recordingPublisher } from '../../support/event-bus-fake.js';
import { fakeFlagReader } from '../../support/flag-reader-fake.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

// transfer is gated by the pointTransfer flag; these tests inject a fake reader
// (default ON) so the transfer path runs, and one case flips it OFF.
const enabled = fakeFlagReader({ pointTransfer: true });

/** Numeric sort — `toSorted()` defaults to lexicographic, which lies about ids. */
const byNumber = (a: number, b: number): number => a - b;

const prisma = await makeTestPrisma();
// Held by name so each test can read what the use-case emitted. Which RUNG a
// use-case publishes at is part of its contract, so it is asserted here.
const events = recordingPublisher();
const outbox = fakeOutbox();
const points = createPointService({ rw: prisma, ro: prisma }, systemClock, { events, outbox });

async function makeUser(email = 'points@example.com') {
  return prisma.user.create({ data: { email } });
}

beforeEach(async () => {
  await resetDb(prisma);
  events.recorded.length = 0;
  outbox.enqueued.length = 0;
});
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
    const world = await pointRepo.loadPointWorld(prisma, user.id);
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

describe('PointService.transfer', () => {
  async function makePair() {
    const [from, to] = await Promise.all([
      makeUser('from@example.com'),
      makeUser('to@example.com'),
    ]);
    return { from, to };
  }

  it('moves points between two users atomically, conserving paid/free kind', async () => {
    const { from, to } = await makePair();
    await points.charge(from.id, { paidAmount: 100, freeAmount: 50 });

    const spend = await points.transfer(from.id, to.id, { amount: 120 }, enabled);
    // Sender spends paid-first: 100 paid + 20 free.
    expect(spend).toMatchObject({ userId: from.id, paidAmount: 100, freeAmount: 20 });

    const fromBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: from.id } });
    expect(fromBalance).toMatchObject({ paidAmount: 0, freeAmount: 30, totalAmount: 30 });

    // The receiver is credited a new USABLE charge with the same split.
    const toBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: to.id } });
    expect(toBalance).toMatchObject({ paidAmount: 100, freeAmount: 20, totalAmount: 120 });
    const toCharge = await prisma.pointCharge.findFirstOrThrow({ where: { userId: to.id } });
    expect(toCharge).toMatchObject({ state: 'USABLE', unspentPaidAmount: 100, unspentFreeAmount: 20 });
  });

  it('spends free points first when the pointTransferPreferFree flag is on (rule change)', async () => {
    const { from, to } = await makePair();
    await points.charge(from.id, { paidAmount: 100, freeAmount: 50 });

    const spend = await points.transfer(
      from.id,
      to.id,
      { amount: 120 },
      fakeFlagReader({ pointTransfer: true, pointTransferPreferFree: true }),
    );
    // Free-first: all 50 free before any paid, then 70 paid.
    expect(spend).toMatchObject({ paidAmount: 70, freeAmount: 50 });

    const fromBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: from.id } });
    expect(fromBalance).toMatchObject({ paidAmount: 30, freeAmount: 0, totalAmount: 30 });
    // The receiver is credited with the same paid/free split.
    const toBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: to.id } });
    expect(toBalance).toMatchObject({ paidAmount: 70, freeAmount: 50, totalAmount: 120 });
  });

  it('rejects a transfer beyond the sender balance, writing nothing', async () => {
    const { from, to } = await makePair();
    await points.charge(from.id, { paidAmount: 10, freeAmount: 0 });

    await expect(points.transfer(from.id, to.id, { amount: 11 }, enabled)).rejects.toBeInstanceOf(
      InsufficientPointError,
    );
    const fromBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: from.id } });
    expect(fromBalance.totalAmount).toBe(10);
    expect(await prisma.pointCharge.count({ where: { userId: to.id } })).toBe(0);
    expect(await prisma.pointSpend.count()).toBe(0);
  });

  it('rejects a transfer to self', async () => {
    const user = await makeUser('self@example.com');
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });

    await expect(points.transfer(user.id, user.id, { amount: 10 }, enabled)).rejects.toBeInstanceOf(
      PointTransferToSelfError,
    );
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: user.id } });
    expect(balance.totalAmount).toBe(100); // untouched
    expect(await prisma.pointSpend.count()).toBe(0);
  });

  it('refuses the transfer when the pointTransfer flag is off, writing nothing', async () => {
    const { from, to } = await makePair();
    await points.charge(from.id, { paidAmount: 100, freeAmount: 0 });

    const disabled = fakeFlagReader({ pointTransfer: false });
    await expect(points.transfer(from.id, to.id, { amount: 60 }, disabled)).rejects.toBeInstanceOf(
      FeatureDisabledError,
    );
    // The gate throws before any lock or write, so nothing moved.
    const fromBalance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: from.id } });
    expect(fromBalance.totalAmount).toBe(100);
    expect(await prisma.pointCharge.count({ where: { userId: to.id } })).toBe(0);
    expect(await prisma.pointSpend.count()).toBe(0);
  });
});

describe('PointService.verifyBalances', () => {
  it('passes for a ledger kept consistent by charge and spend', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 100, freeAmount: 50 });
    await points.spend(user.id, { amount: 120, reason: 'checkout' });

    const result = await points.verifyBalances();
    expect(result.usersChecked).toBeGreaterThanOrEqual(1);
  });

  it('checks a user whose charges are all consumed (balance zero, no usable charge)', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 50, freeAmount: 0 });
    await points.spend(user.id, { amount: 50, reason: 'all' });

    // Balance is now 0 and the charge is CONSUMED — still consistent, so the
    // user (reached via the balance row) is checked and passes.
    await expect(points.verifyBalances()).resolves.toEqual({ usersChecked: 1 });
  });

  it('throws PointBalanceDriftError when a stored balance drifts from its ledger', async () => {
    const user = await makeUser();
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });
    // Corrupt the denormalized cache directly, bypassing the service — the kind
    // of drift a bug elsewhere could cause and this sweep exists to catch.
    await prisma.pointBalance.update({
      where: { userId: user.id },
      data: { paidAmount: 999, totalAmount: 999 },
    });

    await expect(points.verifyBalances()).rejects.toBeInstanceOf(PointBalanceDriftError);
  });
});

describe('delivery rungs — which use-case publishes how', () => {
  it('charge takes rung 1: the event is enqueued in the transaction, not published', async () => {
    const user = await makeUser('rung1@example.com');
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });

    // Money in. Losing this event is a "I paid and got nothing" ticket, so it
    // goes through the outbox and commits with the charge — nothing reaches the
    // bus directly.
    expect(outbox.enqueued).toEqual([
      { topic: 'pointBalanceChanged', key: user.id, payload: { userId: user.id } },
    ]);
    expect(events.recorded).toEqual([]);
  });

  it('spend takes rung 0: published once, directly, after commit', async () => {
    const user = await makeUser('rung0@example.com');
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });
    events.recorded.length = 0;
    outbox.enqueued.length = 0;

    await points.spend(user.id, { amount: 30, reason: 'test' });

    expect(events.recorded).toEqual([
      { topic: 'pointBalanceChanged', key: user.id, payload: { userId: user.id } },
    ]);
    expect(outbox.enqueued).toEqual([]);
  });

  it('a rolled-back spend publishes nothing', async () => {
    const user = await makeUser('rollback@example.com');
    await points.charge(user.id, { paidAmount: 10, freeAmount: 0 });
    events.recorded.length = 0;

    // Overspending throws from the core, so the transaction never commits and
    // no event describes a write that did not land.
    //
    // Scope, honestly: this pins the OBSERVABLE law (a failed use-case emits
    // nothing) but it would NOT catch a publish moved inside the `uow` body,
    // because the core throws before the write either way. The structural
    // property — that the event and the write commit together — is only really
    // provable where the event is itself a row, which is what the rung-1
    // atomicity test in tests/events/outbox.test.ts does.
    await expect(points.spend(user.id, { amount: 999, reason: 'too much' })).rejects.toBeInstanceOf(
      InsufficientPointError,
    );
    expect(events.recorded).toEqual([]);
  });

  it('transfer publishes for BOTH sides', async () => {
    const from = await makeUser('from@example.com');
    const to = await makeUser('to@example.com');
    await points.charge(from.id, { paidAmount: 100, freeAmount: 0 });
    events.recorded.length = 0;

    await points.transfer(from.id, to.id, { amount: 40 }, enabled);

    // The receiver's balance changed too, and keys are per-user — one event
    // cannot serve both. Easy to miss, because the transaction returns only the
    // sender's spend record.
    expect(events.recorded.map((e) => e.key as number).toSorted(byNumber)).toEqual(
      [from.id, to.id].toSorted(byNumber),
    );
  });

  it('expire publishes nothing when nothing was due', async () => {
    const user = await makeUser('noexpiry@example.com');
    await points.charge(user.id, { paidAmount: 100, freeAmount: 0 });
    events.recorded.length = 0;

    // The transaction commits having written nothing. Publishing here would wake
    // every subscriber on every sweep pass to re-read an unchanged balance.
    expect((await points.expire(user.id)).expiredCount).toBe(0);
    expect(events.recorded).toEqual([]);
  });
});
