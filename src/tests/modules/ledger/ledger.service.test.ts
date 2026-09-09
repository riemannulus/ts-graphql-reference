import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConcurrentUpdateError } from '../../../foundation/errors.js';
import { currencyRegistry } from '../../../modules/ledger/currencies/registry.core.js';
import {
  LedgerLotNotRedeemableError,
  LedgerReferenceClosedError,
  LedgerTrialBalanceError,
  type Op,
  planPosting,
  redeemFee,
  selectLotsFifo,
} from '../../../modules/ledger/ledger.core.js';
import { createLedgerService } from '../../../modules/ledger/ledger.service.js';
import * as ledgerRepo from '../../../modules/ledger/ledger.write.repo.js';
import {
  escrowHolder,
  holderKey,
  type Holder,
  payableHolder,
  userHolder,
} from '../../../modules/ledger/ledger.value.js';
import { fixedClock } from '../../support/clock.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';
import { NOW, sequentialIds } from './ledger.arbitraries.js';

// The shell, against a real database: the flows a payments system actually has,
// end to end. Each one is a story someone will have to debug one day, so the
// assertions are about the numbers a support agent would be asked to explain.

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };
const ledger = createLedgerService({ db, clock: fixedClock(NOW), ids: sequentialIds() });

async function makeUser(email: string): Promise<number> {
  const user = await prisma.user.create({ data: { email } });
  return user.id;
}

async function balance(holder: Holder, currency: string): Promise<number> {
  const row = await prisma.ledgerBalance.findUnique({
    where: { holderKey_currency: { holderKey: holderKey(holder), currency } },
  });
  return row?.amount ?? 0;
}

/** Tops a wallet up through the real path, and hands back the lot it minted. */
async function topUp(
  userId: number,
  amounts: { paid?: number; free?: number },
  source: 'PG' | 'IAP' = 'PG',
): Promise<{ referenceId: string; lotIds: readonly number[] }> {
  const reference = await ledger.openReference({ kind: 'CHARGE', initiatorUserId: userId });
  const ops: Op[] = [];
  if (amounts.paid) {
    ops.push({
      op: 'MINT',
      to: userHolder(userId),
      target: { currency: 'PAID_POINT', amount: amounts.paid, source },
      reason: source === 'PG' ? 'PG_CHARGE' : 'IAP_CHARGE',
    });
  }
  if (amounts.free) {
    ops.push({
      op: 'MINT',
      to: userHolder(userId),
      target: { currency: 'FREE_POINT', amount: amounts.free, source: 'EVENT' },
      reason: 'PG_BONUS',
    });
  }
  const result = await ledger.post({
    referenceId: reference.id,
    idempotencyKey: `${reference.id}:mint`,
    actor: { kind: 'USER', id: String(userId) },
    ops,
    closeAs: 'SETTLED',
  });
  return { referenceId: reference.id, lotIds: result.mintedLotIds };
}

/** Grants income directly, the way a migration or an operator would. */
async function grantIncome(userId: number, amount: number): Promise<void> {
  const reference = await ledger.openReference({ kind: 'ADJUST' });
  await ledger.post({
    referenceId: reference.id,
    idempotencyKey: `${reference.id}:grant`,
    actor: { kind: 'STAFF', id: 'ops-1' },
    ops: [
      {
        op: 'MINT',
        to: userHolder(userId),
        target: { currency: 'INCOME', amount, source: null },
        reason: 'ADMIN_GRANT',
      },
    ],
    closeAs: 'SETTLED',
  });
}

/** Stakes `amount` of one currency into a flow's escrow, choosing lots FIFO. */
function stake(referenceId: string, userId: number, currency: 'PAID_POINT' | 'FREE_POINT', amount: number) {
  return ledger.post({
    referenceId,
    idempotencyKey: `${referenceId}:stake`,
    actor: { kind: 'USER', id: String(userId) },
    holders: [userHolder(userId), escrowHolder(referenceId)],
    // The selection runs INSIDE the transaction, on the same snapshot the plan
    // is checked against, so it cannot straddle a concurrent spend.
    decide: (world) => [
      {
        op: 'MOVE',
        from: userHolder(userId),
        to: escrowHolder(referenceId),
        tokens: selectLotsFifo(
          world.lots
            .map((lot) => ({
              lot,
              amount:
                world.lotBalances.find(
                  (row) => row.lotId === lot.id && row.holderKey === holderKey(userHolder(userId)),
                )?.amount ?? 0,
            }))
            .filter((holding) => holding.amount > 0),
          currency,
          amount,
        ),
        reason: 'ORDER_STAKE',
      },
    ],
  });
}

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('a top-up', () => {
  it('mints the paid value and its bonus as separate currencies', async () => {
    const userId = await makeUser('buyer@example.com');
    await topUp(userId, { paid: 10_000, free: 1_000 });

    expect(await balance(userHolder(userId), 'PAID_POINT')).toBe(10_000);
    expect(await balance(userHolder(userId), 'FREE_POINT')).toBe(1_000);

    const lots = await prisma.ledgerLot.findMany({ orderBy: { id: 'asc' } });
    expect(lots.map((lot) => lot.currency)).toEqual(['PAID_POINT', 'FREE_POINT']);
    // The paid lot can be returned to the card; the bonus never could be.
    expect(lots[0]!.cancellableUntil).not.toBeNull();
    expect(lots[1]!.cancellableUntil).toBeNull();
  });

  it('is written once however many times the webhook is delivered', async () => {
    const userId = await makeUser('twice@example.com');
    const reference = await ledger.openReference({ kind: 'CHARGE' });
    const request = {
      referenceId: reference.id,
      idempotencyKey: `${reference.id}:mint`,
      actor: { kind: 'WEBHOOK' as const, id: 'psp' },
      ops: [
        {
          op: 'MINT' as const,
          to: userHolder(userId),
          target: { currency: 'PAID_POINT' as const, amount: 5_000, source: 'PG' as const },
          reason: 'PG_CHARGE' as const,
        },
      ],
      closeAs: 'SETTLED' as const,
    };

    const first = await ledger.post(request);
    const second = await ledger.post(request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.events.map((event) => event.seq)).toEqual(first.events.map((e) => e.seq));
    expect(await balance(userHolder(userId), 'PAID_POINT')).toBe(5_000);
  });

  it('refuses to reopen a finished flow', async () => {
    const userId = await makeUser('closed@example.com');
    const { referenceId } = await topUp(userId, { paid: 100 });
    await expect(
      ledger.post({
        referenceId,
        idempotencyKey: `${referenceId}:again`,
        actor: { kind: 'STAFF', id: 'ops' },
        ops: [
          {
            op: 'MINT',
            to: userHolder(userId),
            target: { currency: 'PAID_POINT', amount: 1, source: 'ADMIN' },
            reason: 'ADMIN_GRANT',
          },
        ],
      }),
    ).rejects.toThrow(LedgerReferenceClosedError);
  });
});

describe('an order', () => {
  it('settles: the buyer pays, the seller earns 90%, the fee comes back as loyalty', async () => {
    const buyer = await makeUser('b@example.com');
    const seller = await makeUser('s@example.com');
    await topUp(buyer, { paid: 10_000 });

    const order = await ledger.openReference({ kind: 'ORDER', initiatorUserId: buyer });
    await stake(order.id, buyer, 'PAID_POINT', 10_000);

    expect(await balance(userHolder(buyer), 'PAID_POINT')).toBe(0);
    expect(await balance(escrowHolder(order.id), 'PAID_POINT')).toBe(10_000);
    expect((await prisma.ledgerReference.findUniqueOrThrow({ where: { id: order.id } })).state).toBe(
      'FUNDED',
    );

    const escrowLots = await prisma.ledgerLotBalance.findMany({
      where: { holderKey: holderKey(escrowHolder(order.id)) },
    });
    await ledger.post({
      referenceId: order.id,
      idempotencyKey: `${order.id}:settle`,
      actor: { kind: 'SYSTEM', id: null },
      ops: [
        {
          op: 'SWAP',
          from: escrowHolder(order.id),
          to: userHolder(seller),
          tokens: escrowLots.map((row) => ({
            currency: 'PAID_POINT' as const,
            amount: row.amount,
            lotId: row.lotId,
          })),
          rate: 'SETTLE',
        },
      ],
      closeAs: 'SETTLED',
    });

    expect(await balance(escrowHolder(order.id), 'PAID_POINT')).toBe(0);
    expect(await balance(userHolder(seller), 'INCOME')).toBe(9_000);
    expect(await balance(userHolder(seller), 'MILEAGE')).toBe(1_000);

    const closed = await prisma.ledgerReference.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed).toMatchObject({ state: 'CLOSED', closeReason: 'SETTLED' });
    // The buyer's points are GONE, not moved: an exchange destroys one currency
    // and creates another, so the supply of each still adds up.
    await expect(ledger.verifyTrialBalance()).resolves.toBeDefined();
  });

  it('reverses: the very same lots come back, with the deadlines they started with', async () => {
    const buyer = await makeUser('refund@example.com');
    const { lotIds } = await topUp(buyer, { paid: 4_000 });
    const before = await prisma.ledgerLot.findUniqueOrThrow({ where: { id: lotIds[0]! } });

    const order = await ledger.openReference({ kind: 'ORDER', initiatorUserId: buyer });
    await stake(order.id, buyer, 'PAID_POINT', 4_000);
    await ledger.post({
      referenceId: order.id,
      idempotencyKey: `${order.id}:refund`,
      actor: { kind: 'STAFF', id: 'support-1' },
      ops: [
        {
          op: 'MOVE',
          from: escrowHolder(order.id),
          to: userHolder(buyer),
          tokens: [{ currency: 'PAID_POINT', amount: 4_000, lotId: lotIds[0]! }],
          reason: 'ORDER_UNSTAKE',
        },
      ],
      closeAs: 'REVERSED',
    });

    expect(await balance(userHolder(buyer), 'PAID_POINT')).toBe(4_000);
    const after = await prisma.ledgerLot.findUniqueOrThrow({ where: { id: lotIds[0]! } });
    // No new lot, no recomputed expiry — the identity survived the round trip.
    expect(after).toEqual(before);
    expect(await prisma.ledgerLot.count()).toBe(1);
  });

  it('splits: part back to the buyer, part on to the seller, in one posting', async () => {
    const buyer = await makeUser('split-b@example.com');
    const seller = await makeUser('split-s@example.com');
    const { lotIds } = await topUp(buyer, { paid: 10_000 });

    const order = await ledger.openReference({ kind: 'ORDER' });
    await stake(order.id, buyer, 'PAID_POINT', 10_000);
    await ledger.post({
      referenceId: order.id,
      idempotencyKey: `${order.id}:split`,
      actor: { kind: 'STAFF', id: 'support-1' },
      ops: [
        {
          op: 'MOVE',
          from: escrowHolder(order.id),
          to: userHolder(buyer),
          tokens: [{ currency: 'PAID_POINT', amount: 6_000, lotId: lotIds[0]! }],
          reason: 'ORDER_UNSTAKE',
        },
        {
          op: 'SWAP',
          from: escrowHolder(order.id),
          to: userHolder(seller),
          tokens: [{ currency: 'PAID_POINT', amount: 4_000, lotId: lotIds[0]! }],
          rate: 'SETTLE',
        },
      ],
      closeAs: 'SPLIT',
    });

    expect(await balance(userHolder(buyer), 'PAID_POINT')).toBe(6_000);
    expect(await balance(userHolder(seller), 'INCOME')).toBe(3_600);
    expect(await balance(userHolder(seller), 'MILEAGE')).toBe(400);
    expect(await balance(escrowHolder(order.id), 'PAID_POINT')).toBe(0);
  });
});

describe('a payout', () => {
  it('holds the money in a payable until the bank confirms, then burns it with its fee', async () => {
    const seller = await makeUser('payout@example.com');
    await grantIncome(seller, 50_000);

    const payout = await ledger.openReference({ kind: 'PAYOUT', initiatorUserId: seller });
    await ledger.post({
      referenceId: payout.id,
      idempotencyKey: `${payout.id}:request`,
      actor: { kind: 'USER', id: String(seller) },
      ops: [
        {
          op: 'MOVE',
          from: userHolder(seller),
          to: payableHolder(payout.id),
          tokens: [{ currency: 'INCOME', amount: 50_000, lotId: null }],
          reason: 'PAYOUT_STAKE',
        },
      ],
    });

    // The money is neither theirs to spend nor gone: it is in a named place.
    expect(await balance(userHolder(seller), 'INCOME')).toBe(0);
    expect(await balance(payableHolder(payout.id), 'INCOME')).toBe(50_000);

    const fee = redeemFee(currencyRegistry.INCOME.redeem!, 50_000);
    await ledger.post({
      referenceId: payout.id,
      idempotencyKey: `${payout.id}:settled`,
      actor: { kind: 'WEBHOOK', id: 'bank' },
      ops: [
        {
          op: 'BURN',
          from: payableHolder(payout.id),
          tokens: [{ currency: 'INCOME', amount: 50_000, lotId: null }],
          reason: 'BANK_WITHDRAWAL',
          feeKrw: fee,
          externalRef: 'bank-seq-0001',
        },
      ],
      closeAs: 'SETTLED',
    });

    expect(await balance(payableHolder(payout.id), 'INCOME')).toBe(0);
    const burn = await prisma.ledgerEvent.findFirstOrThrow({ where: { op: 'BURN' } });
    expect(burn).toMatchObject({ reason: 'BANK_WITHDRAWAL', externalRef: 'bank-seq-0001' });
    // The platform's cut was taken at settlement, so a payout is not charged twice.
    expect(fee).toBe(0);
  });

  it('gives the money back when the transfer fails — a move, not a compensating entry', async () => {
    const seller = await makeUser('failed-payout@example.com');
    await grantIncome(seller, 20_000);

    const payout = await ledger.openReference({ kind: 'PAYOUT' });
    await ledger.post({
      referenceId: payout.id,
      idempotencyKey: `${payout.id}:request`,
      actor: { kind: 'USER', id: String(seller) },
      ops: [
        {
          op: 'MOVE',
          from: userHolder(seller),
          to: payableHolder(payout.id),
          tokens: [{ currency: 'INCOME', amount: 20_000, lotId: null }],
          reason: 'PAYOUT_STAKE',
        },
      ],
    });
    await ledger.post({
      referenceId: payout.id,
      idempotencyKey: `${payout.id}:failed`,
      actor: { kind: 'SYSTEM', id: null },
      ops: [
        {
          op: 'MOVE',
          from: payableHolder(payout.id),
          to: userHolder(seller),
          tokens: [{ currency: 'INCOME', amount: 20_000, lotId: null }],
          reason: 'PAYOUT_UNSTAKE',
        },
      ],
      closeAs: 'REVERSED',
    });

    expect(await balance(userHolder(seller), 'INCOME')).toBe(20_000);
    const ops = await prisma.ledgerEvent.findMany({ orderBy: { seq: 'asc' } });
    // Nothing was minted to undo anything: the supply never changed.
    expect(ops.filter((event) => event.op === 'MINT')).toHaveLength(1); // just the grant
  });
});

describe('converting income into points', () => {
  it('marks the new lot with where it came from, and that closes the cash-out loop', async () => {
    const seller = await makeUser('convert@example.com');
    await grantIncome(seller, 30_000);

    const conversion = await ledger.openReference({ kind: 'CONVERSION', initiatorUserId: seller });
    const result = await ledger.post({
      referenceId: conversion.id,
      idempotencyKey: `${conversion.id}:convert`,
      actor: { kind: 'USER', id: String(seller) },
      ops: [
        {
          op: 'SWAP',
          from: userHolder(seller),
          to: userHolder(seller),
          tokens: [{ currency: 'INCOME', amount: 30_000, lotId: null }],
          rate: 'POINT_CONVERSION',
        },
      ],
      closeAs: 'SETTLED',
    });

    expect(await balance(userHolder(seller), 'INCOME')).toBe(0);
    expect(await balance(userHolder(seller), 'PAID_POINT')).toBe(30_000);
    const lot = await prisma.ledgerLot.findUniqueOrThrow({
      where: { id: result.mintedLotIds[0]! },
    });
    expect(lot.source).toBe('INCOME_SWAP');

    // …and those points cannot be paid out again: the route back to cash is the
    // income payout, which carries the checks this one skipped.
    const payout = await ledger.openReference({ kind: 'PAYOUT' });
    await expect(
      ledger.post({
        referenceId: payout.id,
        idempotencyKey: `${payout.id}:request`,
        actor: { kind: 'USER', id: String(seller) },
        ops: [
          {
            op: 'MOVE',
            from: userHolder(seller),
            to: payableHolder(payout.id),
            tokens: [{ currency: 'PAID_POINT', amount: 30_000, lotId: lot.id }],
            reason: 'PAYOUT_STAKE',
          },
        ],
      }),
    ).rejects.toThrow(LedgerLotNotRedeemableError);
  });
});

describe('a gift', () => {
  it("turns the giver's paid value into the receiver's free value", async () => {
    const giver = await makeUser('giver@example.com');
    const receiver = await makeUser('receiver@example.com');
    await topUp(giver, { paid: 5_000 });

    const gift = await ledger.openReference({ kind: 'GIFT', initiatorUserId: giver });
    await stake(gift.id, giver, 'PAID_POINT', 5_000);
    const escrowLots = await prisma.ledgerLotBalance.findMany({
      where: { holderKey: holderKey(escrowHolder(gift.id)) },
    });
    await ledger.post({
      referenceId: gift.id,
      idempotencyKey: `${gift.id}:redeem`,
      actor: { kind: 'USER', id: String(receiver) },
      ops: [
        {
          op: 'SWAP',
          from: escrowHolder(gift.id),
          to: userHolder(receiver),
          tokens: escrowLots.map((row) => ({
            currency: 'PAID_POINT' as const,
            amount: row.amount,
            lotId: row.lotId,
          })),
          rate: 'GIFT_CARD_REDEEM',
        },
      ],
      closeAs: 'SETTLED',
    });

    expect(await balance(userHolder(giver), 'PAID_POINT')).toBe(0);
    expect(await balance(userHolder(receiver), 'FREE_POINT')).toBe(5_000);
    // Free value has no route to a bank account, so a gift cannot be cashed out.
    expect(await balance(userHolder(receiver), 'PAID_POINT')).toBe(0);
  });

  it('the stake was into a flow, so an unredeemed gift can go back', async () => {
    const giver = await makeUser('unclaimed@example.com');
    const { lotIds } = await topUp(giver, { paid: 5_000 });
    const gift = await ledger.openReference({ kind: 'GIFT' });
    await stake(gift.id, giver, 'PAID_POINT', 5_000);

    await ledger.post({
      referenceId: gift.id,
      idempotencyKey: `${gift.id}:return`,
      actor: { kind: 'SYSTEM', id: null },
      ops: [
        {
          op: 'MOVE',
          from: escrowHolder(gift.id),
          to: userHolder(giver),
          tokens: [{ currency: 'PAID_POINT', amount: 5_000, lotId: lotIds[0]! }],
          reason: 'GIFT_UNSTAKE',
        },
      ],
      closeAs: 'REVERSED',
    });
    expect(await balance(userHolder(giver), 'PAID_POINT')).toBe(5_000);
  });

  it('re-mints free value as free value, which is a swap and not a transfer', async () => {
    const giver = await makeUser('free-giver@example.com');
    const receiver = await makeUser('free-receiver@example.com');
    await topUp(giver, { paid: 1_000, free: 4_000 });

    const gift = await ledger.openReference({ kind: 'GIFT', initiatorUserId: giver });
    await stake(gift.id, giver, 'FREE_POINT', 4_000);
    const escrowLots = await prisma.ledgerLotBalance.findMany({
      where: { holderKey: holderKey(escrowHolder(gift.id)) },
    });
    await ledger.post({
      referenceId: gift.id,
      idempotencyKey: `${gift.id}:redeem`,
      actor: { kind: 'USER', id: String(receiver) },
      ops: [
        {
          op: 'SWAP',
          from: escrowHolder(gift.id),
          to: userHolder(receiver),
          tokens: escrowLots.map((row) => ({
            currency: 'FREE_POINT' as const,
            amount: row.amount,
            lotId: row.lotId,
          })),
          rate: 'GIFT_CARD_REDEEM',
        },
      ],
      closeAs: 'SETTLED',
    });

    expect(await balance(userHolder(giver), 'FREE_POINT')).toBe(0);
    expect(await balance(userHolder(receiver), 'FREE_POINT')).toBe(4_000);
    // Both sides of the swap name the same currency, and the header records it.
    const swap = await prisma.ledgerSwap.findFirstOrThrow({ where: { referenceId: gift.id } });
    expect(swap).toMatchObject({ burnCurrency: 'FREE_POINT', mintCurrency: 'FREE_POINT' });
    // The giver's lots died; the receiver holds NEW ones, with their own source.
    const received = await prisma.ledgerLot.findMany({ where: { ownerUserId: receiver } });
    expect(received.map((lot) => lot.source)).toEqual(['GIFT_CARD']);
    expect(received.map((lot) => lot.id)).not.toContain(escrowLots[0]!.lotId);
  });
});

describe('the lost race', () => {
  it('refuses a plan whose world moved underneath it', async () => {
    const buyer = await makeUser('race@example.com');
    const { lotIds } = await topUp(buyer, { paid: 1_000 });
    const order = await ledger.openReference({ kind: 'ORDER' });

    // Decide against the world as it is now…
    const world = await ledgerRepo.loadLedgerWorld(prisma, order.id, [
      userHolder(buyer),
      escrowHolder(order.id),
    ]);
    const plan = planPosting(
      world,
      {
        referenceId: order.id,
        idempotencyKey: `${order.id}:stale`,
        actor: { kind: 'USER', id: String(buyer) },
        ops: [
          {
            op: 'MOVE',
            from: userHolder(buyer),
            to: escrowHolder(order.id),
            tokens: [{ currency: 'PAID_POINT', amount: 1_000, lotId: lotIds[0]! }],
            reason: 'ORDER_STAKE',
          },
        ],
      },
      currencyRegistry,
      NOW,
    );

    // …then let someone else spend first.
    const other = await ledger.openReference({ kind: 'ORDER' });
    await stake(other.id, buyer, 'PAID_POINT', 1_000);

    await expect(
      prisma.$transaction((tx) => ledgerRepo.applyPostingPlan(tx, plan)),
    ).rejects.toThrow(ConcurrentUpdateError);
    // The winner keeps the money; the loser wrote nothing.
    expect(await balance(escrowHolder(order.id), 'PAID_POINT')).toBe(0);
    expect(await balance(escrowHolder(other.id), 'PAID_POINT')).toBe(1_000);
  });
});

describe('the sweeps', () => {
  it('expires what is past its deadline in a wallet, and leaves an order alone', async () => {
    const buyer = await makeUser('expiry@example.com');
    await topUp(buyer, { paid: 3_000 });
    const order = await ledger.openReference({ kind: 'ORDER' });
    await stake(order.id, buyer, 'PAID_POINT', 1_000);

    // Six years on, everything minted today is long past its five-year life.
    const later = new Date('2032-06-01T00:00:00.000Z');
    const result = await ledger.expireDueLots({ now: later });

    expect(result.expiredCount).toBe(1);
    expect(result.burnedAmount).toBe(2_000);
    expect(await balance(userHolder(buyer), 'PAID_POINT')).toBe(0);
    // The staked half is still in the order, which may yet refund it.
    expect(await balance(escrowHolder(order.id), 'PAID_POINT')).toBe(1_000);
    await expect(ledger.verifyTrialBalance()).resolves.toBeDefined();
  });

  it('does nothing, cheaply, when nothing is due', async () => {
    const buyer = await makeUser('nothing-due@example.com');
    await topUp(buyer, { paid: 1_000 });
    const before = await prisma.ledgerReference.count();

    expect(await ledger.expireDueLots()).toMatchObject({ expiredCount: 0, referenceId: null });
    // No flow was opened just to discover there was no work.
    expect(await prisma.ledgerReference.count()).toBe(before);
  });

  it('voids an abandoned flow, and never one that holds money', async () => {
    const buyer = await makeUser('stale@example.com');
    await topUp(buyer, { paid: 1_000 });
    const abandoned = await ledger.openReference({
      kind: 'CHARGE',
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const live = await ledger.openReference({
      kind: 'ORDER',
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    await stake(live.id, buyer, 'PAID_POINT', 1_000);

    expect(await ledger.voidStaleReferences()).toEqual({ voidedCount: 1 });
    expect(
      await prisma.ledgerReference.findUniqueOrThrow({ where: { id: abandoned.id } }),
    ).toMatchObject({ state: 'CLOSED', closeReason: 'VOID' });
    // The funded one is past its window too, but money moved under it.
    expect(
      (await prisma.ledgerReference.findUniqueOrThrow({ where: { id: live.id } })).state,
    ).toBe('FUNDED');
  });
});

describe('the trial balance', () => {
  it('holds across a whole order, and reports every currency', async () => {
    const buyer = await makeUser('trial-b@example.com');
    const seller = await makeUser('trial-s@example.com');
    await topUp(buyer, { paid: 10_000, free: 2_000 });
    const order = await ledger.openReference({ kind: 'ORDER' });
    await stake(order.id, buyer, 'PAID_POINT', 10_000);
    const escrowLots = await prisma.ledgerLotBalance.findMany({
      where: { holderKey: holderKey(escrowHolder(order.id)) },
    });
    await ledger.post({
      referenceId: order.id,
      idempotencyKey: `${order.id}:settle`,
      actor: { kind: 'SYSTEM', id: null },
      ops: [
        {
          op: 'SWAP',
          from: escrowHolder(order.id),
          to: userHolder(seller),
          tokens: escrowLots.map((row) => ({
            currency: 'PAID_POINT' as const,
            amount: row.amount,
            lotId: row.lotId,
          })),
          rate: 'SETTLE',
        },
      ],
      closeAs: 'SETTLED',
    });

    const { rows } = await ledger.verifyTrialBalance();
    expect(rows).toEqual([
      { currency: 'PAID_POINT', minted: 10_000, burned: 10_000, held: 0 },
      { currency: 'FREE_POINT', minted: 2_000, burned: 0, held: 2_000 },
      { currency: 'INCOME', minted: 9_000, burned: 0, held: 9_000 },
      { currency: 'MILEAGE', minted: 1_000, burned: 0, held: 1_000 },
    ]);
  });

  it('shouts when a balance stops matching the log, instead of quietly fixing it', async () => {
    const buyer = await makeUser('drift@example.com');
    await topUp(buyer, { paid: 1_000 });
    await prisma.ledgerBalance.update({
      where: { holderKey_currency: { holderKey: holderKey(userHolder(buyer)), currency: 'PAID_POINT' } },
      data: { amount: 999 },
    });

    await expect(ledger.verifyTrialBalance()).rejects.toThrow(LedgerTrialBalanceError);
  });
});
