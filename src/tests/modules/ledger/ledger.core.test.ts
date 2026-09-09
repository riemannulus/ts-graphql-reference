import { describe, expect, it } from 'vitest';
import { currencyRegistry } from '../../../modules/ledger/currencies/registry.core.js';
import {
  holdersOf,
  LedgerBelowPayoutMinimumError,
  LedgerCloseNotEmptyError,
  LedgerCloseReasonRequiredError,
  LedgerFeeNotAllowedError,
  LedgerForeignHolderError,
  LedgerInsufficientBalanceError,
  LedgerLotNotCancellableError,
  LedgerLotNotDueError,
  LedgerLotNotRedeemableError,
  LedgerMovementNotAllowedError,
  LedgerNothingToBurnError,
  LedgerReasonNotAllowedError,
  LedgerReferenceClosedError,
  LedgerSwapNotAllowedError,
  LedgerVoidNotEmptyError,
  type Op,
  planPosting,
  type Posting,
  redeemFee,
  selectLotsFifo,
  SWAP_RATES,
} from '../../../modules/ledger/ledger.core.js';
import {
  escrowHolder,
  holderKey,
  payableHolder,
  receivableHolder,
  userHolder,
} from '../../../modules/ledger/ledger.value.js';
import {
  buildWorld,
  FAR_FUTURE,
  GIFT_REF,
  LONG_AGO,
  NOW,
  ORDER_REF,
  PAYOUT_REF,
  SOON,
} from './ledger.arbitraries.js';

// The kernel's decisions, by example. Every case here is a rule someone would
// otherwise have to rediscover from a production incident.

const BUYER = userHolder(1);
const SELLER = userHolder(2);
const ESCROW = escrowHolder(ORDER_REF);
const PAYABLE = payableHolder(PAYOUT_REF);

function post(ops: readonly Op[], extra: Partial<Posting> = {}): Posting {
  return {
    referenceId: ORDER_REF,
    idempotencyKey: 'key-1',
    actor: { kind: 'USER', id: '1' },
    ops,
    ...extra,
  };
}

const plan = (world: Parameters<typeof planPosting>[0], posting: Posting, now = NOW) =>
  planPosting(world, posting, currencyRegistry, now);

describe('planPosting — minting', () => {
  it('creates a lot whose deadlines come from the policy, not the caller', () => {
    const world = buildWorld({ referenceId: 'CH-0000000001' });
    const result = plan(
      world,
      post(
        [
          {
            op: 'MINT',
            to: BUYER,
            target: { currency: 'PAID_POINT', amount: 5_000, source: 'PG' },
            reason: 'PG_CHARGE',
          },
        ],
        { referenceId: 'CH-0000000001' },
      ),
    );

    expect(result.lotsToCreate).toHaveLength(1);
    const lot = result.lotsToCreate[0]!;
    expect(lot.originalAmount).toBe(5_000);
    // 5 years of life, 7 days to change your mind — both from PAID_POINT_POLICY.
    expect(lot.validUntil.getFullYear()).toBe(2031);
    expect(lot.cancellableUntil).toEqual(new Date('2026-06-08T00:00:00.000Z'));
    expect(result.balanceWrites).toEqual([
      { holderKey: 'USER:1', currency: 'PAID_POINT', assumed: null, after: 5_000 },
    ]);
  });

  it('leaves a lot uncancellable when its funding source cannot be unwound', () => {
    const world = buildWorld({ referenceId: 'CH-0000000001' });
    const result = plan(
      world,
      post(
        [
          {
            op: 'MINT',
            to: BUYER,
            target: { currency: 'PAID_POINT', amount: 100, source: 'IAP' },
            reason: 'IAP_CHARGE',
          },
        ],
        { referenceId: 'CH-0000000001' },
      ),
    );
    expect(result.lotsToCreate[0]!.cancellableUntil).toBeNull();
  });

  it('refuses to mint straight into an escrow (an order cannot fund itself)', () => {
    const world = buildWorld();
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MINT',
            to: ESCROW,
            target: { currency: 'PAID_POINT', amount: 100, source: 'PG' },
            reason: 'PG_CHARGE',
          },
        ]),
      ),
    ).toThrow(LedgerMovementNotAllowedError);
  });

  it('refuses a reason the currency does not admit', () => {
    const world = buildWorld();
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MINT',
            to: BUYER,
            target: { currency: 'PAID_POINT', amount: 100, source: 'EVENT' },
            reason: 'PG_BONUS', // a bonus is free value, never paid value
          },
        ]),
      ),
    ).toThrow(LedgerReasonNotAllowedError);
  });
});

describe('planPosting — moving', () => {
  const world = () =>
    buildWorld({
      lots: [{ id: 10, currency: 'PAID_POINT', ownerUserId: 1, amount: 1_000, at: BUYER }],
      referenceHolders: [ESCROW],
    });

  it('stakes into escrow without changing the supply', () => {
    const result = plan(
      world(),
      post([
        {
          op: 'MOVE',
          from: BUYER,
          to: ESCROW,
          tokens: [{ currency: 'PAID_POINT', amount: 400, lotId: 10 }],
          reason: 'ORDER_STAKE',
        },
      ]),
    );

    const byHolder = Object.fromEntries(
      result.balanceWrites.map((write) => [write.holderKey, write]),
    );
    expect(byHolder['USER:1']).toMatchObject({ assumed: 1_000, after: 600 });
    expect(byHolder[holderKey(ESCROW)]).toMatchObject({ assumed: null, after: 400 });
    // One MOVE event, no mint and no burn: the supply did not change.
    expect(result.events.map((event) => event.op)).toEqual(['MOVE']);
    expect(result.reference.nextState).toBe('FUNDED');
  });

  it('carries the SAME lot to the other side, so a refund keeps its deadlines', () => {
    const result = plan(
      world(),
      post([
        {
          op: 'MOVE',
          from: BUYER,
          to: ESCROW,
          tokens: [{ currency: 'PAID_POINT', amount: 400, lotId: 10 }],
          reason: 'ORDER_STAKE',
        },
      ]),
    );
    expect(result.lotBalanceWrites).toEqual(
      expect.arrayContaining([
        { lot: { kind: 'EXISTING', lotId: 10 }, holderKey: 'USER:1', assumed: 1_000, after: 600 },
        {
          lot: { kind: 'EXISTING', lotId: 10 },
          holderKey: holderKey(ESCROW),
          assumed: null,
          after: 400,
        },
      ]),
    );
    expect(result.lotsToCreate).toHaveLength(0);
  });

  it('refuses to move more than the holder has', () => {
    expect(() =>
      plan(
        world(),
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: ESCROW,
            tokens: [{ currency: 'PAID_POINT', amount: 1_001, lotId: 10 }],
            reason: 'ORDER_STAKE',
          },
        ]),
      ),
    ).toThrow(LedgerInsufficientBalanceError);
  });

  it('has no wallet-to-wallet shape at all: a gift must go through a flow', () => {
    expect(() =>
      plan(
        world(),
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: SELLER,
            tokens: [{ currency: 'PAID_POINT', amount: 100, lotId: 10 }],
            reason: 'GIFT_STAKE',
          },
        ]),
      ),
    ).toThrow(LedgerMovementNotAllowedError);
  });

  it('keeps free value away from a payout, and does so three times over', () => {
    const free = buildWorld({
      referenceId: PAYOUT_REF,
      lots: [{ id: 11, currency: 'FREE_POINT', ownerUserId: 1, amount: 500, at: BUYER }],
    });
    expect(() =>
      plan(
        free,
        post(
          [
            {
              op: 'MOVE',
              from: BUYER,
              to: PAYABLE,
              tokens: [{ currency: 'FREE_POINT', amount: 500, lotId: 11 }],
              reason: 'PAYOUT_STAKE',
            },
          ],
          { referenceId: PAYOUT_REF },
        ),
      ),
    ).toThrow(LedgerReasonNotAllowedError);

    // The refusal above is the first of three independent facts, none of which
    // is a guard someone can forget to call: the reason is not in the policy's
    // set, a payable is not a holder kind it admits, and it has no redeem policy
    // for `PAYOUT_STAKE` to require.
    const policy = currencyRegistry.FREE_POINT;
    expect(policy.moveReasons).not.toContain('PAYOUT_STAKE');
    expect(policy.holderKinds).not.toContain('PAYABLE');
    expect(policy.redeem).toBeNull();
  });

  it('refuses a currency the destination account cannot hold at all', () => {
    const income = buildWorld({
      scalars: [{ holder: BUYER, currency: 'INCOME', amount: 5_000 }],
      referenceHolders: [ESCROW],
    });
    // Income in an escrow would mean an order had settled and not settled at once.
    expect(currencyRegistry.INCOME.holderKinds).not.toContain('ESCROW');
    expect(() =>
      plan(
        income,
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: ESCROW,
            tokens: [{ currency: 'INCOME', amount: 5_000, lotId: null }],
            reason: 'ORDER_STAKE',
          },
        ]),
      ),
    ).toThrow(LedgerReasonNotAllowedError);
  });

  it('refuses to pay out a lot whose source the store must refund instead', () => {
    const bought = buildWorld({
      referenceId: PAYOUT_REF,
      lots: [
        {
          id: 12,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 50_000,
          at: BUYER,
          source: 'IAP',
          cancellableUntil: null,
        },
      ],
    });
    expect(() =>
      plan(
        bought,
        post(
          [
            {
              op: 'MOVE',
              from: BUYER,
              to: PAYABLE,
              tokens: [{ currency: 'PAID_POINT', amount: 50_000, lotId: 12 }],
              reason: 'PAYOUT_STAKE',
            },
          ],
          { referenceId: PAYOUT_REF },
        ),
      ),
    ).toThrow(LedgerLotNotRedeemableError);
  });

  it('cannot move mileage anywhere: the currency has no move reasons', () => {
    const mileage = buildWorld({
      scalars: [{ holder: BUYER, currency: 'MILEAGE', amount: 900 }],
    });
    expect(() =>
      plan(
        mileage,
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: ESCROW,
            tokens: [{ currency: 'MILEAGE', amount: 100, lotId: null }],
            reason: 'ORDER_STAKE',
          },
        ]),
      ),
    ).toThrow(LedgerReasonNotAllowedError);
  });
});

describe('planPosting — burning', () => {
  it('returns an untouched lot to its funding source inside the window', () => {
    const world = buildWorld({
      referenceId: 'CH-0000000001',
      lots: [
        {
          id: 20,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 3_000,
          originalAmount: 3_000,
          at: BUYER,
          cancellableUntil: SOON,
        },
      ],
    });
    const result = plan(
      world,
      post(
        [
          {
            op: 'BURN',
            from: BUYER,
            tokens: [{ currency: 'PAID_POINT', amount: 3_000, lotId: 20 }],
            reason: 'PG_REFUND',
            externalRef: 'psp-cancel-1',
          },
        ],
        { referenceId: 'CH-0000000001', closeAs: 'REVERSED' },
      ),
    );
    expect(result.events[0]).toMatchObject({ op: 'BURN', externalRef: 'psp-cancel-1' });
    expect(result.balanceWrites[0]).toMatchObject({ after: 0 });
  });

  it('refuses the return once anything has been spent from the lot', () => {
    const world = buildWorld({
      referenceId: 'CH-0000000001',
      lots: [
        {
          id: 21,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 2_999, // one point already went somewhere
          originalAmount: 3_000,
          at: BUYER,
          cancellableUntil: SOON,
        },
      ],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'BURN',
              from: BUYER,
              tokens: [{ currency: 'PAID_POINT', amount: 2_999, lotId: 21 }],
              reason: 'PG_REFUND',
            },
          ],
          { referenceId: 'CH-0000000001' },
        ),
      ),
    ).toThrow(LedgerLotNotCancellableError);
  });

  it('refuses the return once the window has closed', () => {
    const world = buildWorld({
      referenceId: 'CH-0000000001',
      lots: [
        {
          id: 22,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 3_000,
          at: BUYER,
          cancellableUntil: LONG_AGO,
        },
      ],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'BURN',
              from: BUYER,
              tokens: [{ currency: 'PAID_POINT', amount: 3_000, lotId: 22 }],
              reason: 'PG_REFUND',
            },
          ],
          { referenceId: 'CH-0000000001' },
        ),
      ),
    ).toThrow(LedgerLotNotCancellableError);
  });

  it('refuses to expire a lot that is still alive', () => {
    const world = buildWorld({
      referenceId: 'AD-0000000001',
      lots: [
        {
          id: 23,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 100,
          at: BUYER,
          validUntil: FAR_FUTURE,
        },
      ],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'BURN',
              from: BUYER,
              tokens: [{ currency: 'PAID_POINT', amount: 100, lotId: 23 }],
              reason: 'EXPIRED',
            },
          ],
          { referenceId: 'AD-0000000001' },
        ),
      ),
    ).toThrow(LedgerLotNotDueError);
  });

  it('lets cash ride only on the burns that actually move cash', () => {
    const world = buildWorld({
      referenceId: 'AD-0000000001',
      lots: [{ id: 24, currency: 'PAID_POINT', ownerUserId: 1, amount: 100, at: BUYER }],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'BURN',
              from: BUYER,
              tokens: [{ currency: 'PAID_POINT', amount: 100, lotId: 24 }],
              reason: 'ADMIN_REVOKE',
              feeKrw: 100,
            },
          ],
          { referenceId: 'AD-0000000001' },
        ),
      ),
    ).toThrow(LedgerFeeNotAllowedError);
  });

  it('decides a withdrawal fee itself, and refuses to be told one', () => {
    const world = buildWorld({
      referenceId: PAYOUT_REF,
      scalars: [{ holder: PAYABLE, currency: 'INCOME', amount: 50_000 }],
      referenceHolders: [PAYABLE],
    });
    const withdrawal = (feeKrw?: number) =>
      post(
        [
          {
            op: 'BURN',
            from: PAYABLE,
            tokens: [{ currency: 'INCOME', amount: 50_000, lotId: null }],
            reason: 'BANK_WITHDRAWAL',
            ...(feeKrw === undefined ? {} : { feeKrw }),
          },
        ],
        { referenceId: PAYOUT_REF, closeAs: 'SETTLED' },
      );

    // A caller naming its own fee would make the redeem policy decorative.
    expect(() => plan(world, withdrawal(999_999))).toThrow(LedgerFeeNotAllowedError);
    // Income's policy takes no cut at payout — the platform's was taken at
    // settlement — so the kernel computes exactly zero.
    expect(plan(world, withdrawal()).events[0]!.feeKrw).toBe(0);
  });

  it('refuses a burn of nothing, which a fee could otherwise ride out on', () => {
    const world = buildWorld({ referenceId: 'AD-0000000001' });
    expect(() =>
      plan(
        world,
        post(
          [{ op: 'BURN', from: BUYER, tokens: [], reason: 'ADMIN_REVOKE' }],
          { referenceId: 'AD-0000000001' },
        ),
      ),
    ).toThrow(LedgerNothingToBurnError);
  });

  it('sends value to the bank only out of a payable', () => {
    const world = buildWorld({
      referenceId: PAYOUT_REF,
      scalars: [{ holder: BUYER, currency: 'INCOME', amount: 50_000 }],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'BURN',
              from: BUYER,
              tokens: [{ currency: 'INCOME', amount: 50_000, lotId: null }],
              reason: 'BANK_WITHDRAWAL',
            },
          ],
          { referenceId: PAYOUT_REF },
        ),
      ),
    ).toThrow(LedgerMovementNotAllowedError);
  });
});

describe('planPosting — swapping', () => {
  const settleWorld = () =>
    buildWorld({
      state: 'FUNDED',
      lots: [{ id: 30, currency: 'PAID_POINT', ownerUserId: 1, amount: 10_000, at: ESCROW }],
      referenceHolders: [ESCROW],
    });

  it('splits an order between the seller and the fee, and hands the fee back as loyalty', () => {
    const result = plan(
      settleWorld(),
      post(
        [
          {
            op: 'SWAP',
            from: ESCROW,
            to: SELLER,
            tokens: [{ currency: 'PAID_POINT', amount: 10_000, lotId: 30 }],
            rate: 'SETTLE',
          },
        ],
        { closeAs: 'SETTLED' },
      ),
    );

    const swap = result.swapsToCreate[0]!;
    expect(swap).toMatchObject({ burnCurrency: 'PAID_POINT', mintCurrency: 'INCOME', feeKrw: 1_000 });

    const minted = result.events.filter((event) => event.op === 'SWAP_MINT');
    expect(minted.map((event) => [event.currency, event.amount])).toEqual([
      ['INCOME', 9_000],
      ['MILEAGE', 1_000],
    ]);
    // Law L2: what was destroyed equals what was created plus the fee, and the
    // rebate IS the fee — one number, so they cannot drift apart.
    expect(9_000 + swap.feeKrw).toBe(10_000);
    expect(minted[1]!.amount).toBe(swap.feeKrw);
    expect(result.reference).toMatchObject({ nextState: 'CLOSED', closeReason: 'SETTLED' });
  });

  it('needs one header per burn currency, so a mixed escrow settles as two swaps', () => {
    const mixed = buildWorld({
      state: 'FUNDED',
      lots: [
        { id: 31, currency: 'PAID_POINT', ownerUserId: 1, amount: 6_000, at: ESCROW },
        { id: 32, currency: 'FREE_POINT', ownerUserId: 1, amount: 4_000, at: ESCROW },
      ],
      referenceHolders: [ESCROW],
    });
    expect(() =>
      plan(
        mixed,
        post([
          {
            op: 'SWAP',
            from: ESCROW,
            to: SELLER,
            tokens: [
              { currency: 'PAID_POINT', amount: 6_000, lotId: 31 },
              { currency: 'FREE_POINT', amount: 4_000, lotId: 32 },
            ],
            rate: 'SETTLE',
          },
        ]),
      ),
    ).toThrow(LedgerSwapNotAllowedError);

    // As two ops it is fine, and the fees add up to the same 10%.
    const result = plan(
      mixed,
      post(
        [
          {
            op: 'SWAP',
            from: ESCROW,
            to: SELLER,
            tokens: [{ currency: 'PAID_POINT', amount: 6_000, lotId: 31 }],
            rate: 'SETTLE',
          },
          {
            op: 'SWAP',
            from: ESCROW,
            to: SELLER,
            tokens: [{ currency: 'FREE_POINT', amount: 4_000, lotId: 32 }],
            rate: 'SETTLE',
          },
        ],
        { closeAs: 'SETTLED' },
      ),
    );
    expect(result.swapsToCreate.map((swap) => swap.feeKrw)).toEqual([600, 400]);
  });

  it('turns income into spendable points, marked with where they came from', () => {
    const world = buildWorld({
      referenceId: 'CV-0000000001',
      scalars: [{ holder: SELLER, currency: 'INCOME', amount: 20_000 }],
    });
    const result = plan(
      world,
      post(
        [
          {
            op: 'SWAP',
            from: SELLER,
            to: SELLER,
            tokens: [{ currency: 'INCOME', amount: 20_000, lotId: null }],
            rate: 'POINT_CONVERSION',
          },
        ],
        { referenceId: 'CV-0000000001', closeAs: 'SETTLED' },
      ),
    );
    // One for one — no fee on this edge.
    expect(result.swapsToCreate[0]!.feeKrw).toBe(0);
    expect(result.lotsToCreate[0]).toMatchObject({
      currency: 'PAID_POINT',
      originalAmount: 20_000,
      source: 'INCOME_SWAP',
    });
  });

  it('redeems a gift into the receiver’s free points', () => {
    const world = buildWorld({
      referenceId: GIFT_REF,
      state: 'FUNDED',
      lots: [
        {
          id: 33,
          currency: 'PAID_POINT',
          ownerUserId: 1,
          amount: 5_000,
          at: escrowHolder(GIFT_REF),
        },
      ],
      referenceHolders: [escrowHolder(GIFT_REF)],
    });
    const result = plan(
      world,
      post(
        [
          {
            op: 'SWAP',
            from: escrowHolder(GIFT_REF),
            to: SELLER,
            tokens: [{ currency: 'PAID_POINT', amount: 5_000, lotId: 33 }],
            rate: 'GIFT_CARD_REDEEM',
          },
        ],
        { referenceId: GIFT_REF, closeAs: 'SETTLED' },
      ),
    );
    // Paid value becomes FREE value in the receiver's hands: a gift cannot be
    // laundered into a withdrawal.
    expect(result.lotsToCreate[0]).toMatchObject({
      currency: 'FREE_POINT',
      ownerUserId: 2,
      source: 'GIFT_CARD',
    });
  });

  it('has no edge out of mileage — and TypeScript already knew', () => {
    // `rate.from` is a literal tuple, so `includes('MILEAGE')` does not even
    // typecheck without widening: the graph is closed at compile time, and this
    // widened check is the runtime restatement of that fact.
    const outgoing = Object.values(SWAP_RATES).filter((rate) =>
      (rate.from as readonly string[]).includes('MILEAGE'),
    );
    expect(outgoing).toEqual([]);
  });
});

describe('planPosting — the flow lifecycle', () => {
  it('refuses a posting on a finished flow', () => {
    const world = buildWorld({ state: 'CLOSED' });
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MINT',
            to: BUYER,
            target: { currency: 'PAID_POINT', amount: 1, source: 'PG' },
            reason: 'PG_CHARGE',
          },
        ]),
      ),
    ).toThrow(LedgerReferenceClosedError);
  });

  it('will not let a flow end anonymously', () => {
    const world = buildWorld({
      state: 'FUNDED',
      lots: [{ id: 40, currency: 'PAID_POINT', ownerUserId: 1, amount: 700, at: ESCROW }],
      referenceHolders: [ESCROW],
    });
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MOVE',
            from: ESCROW,
            to: BUYER,
            tokens: [{ currency: 'PAID_POINT', amount: 700, lotId: 40 }],
            reason: 'ORDER_UNSTAKE',
          },
        ]),
      ),
    ).toThrow(LedgerCloseReasonRequiredError);
  });

  it('will not close a flow that still holds value (law L3)', () => {
    const world = buildWorld({
      state: 'FUNDED',
      lots: [{ id: 41, currency: 'PAID_POINT', ownerUserId: 1, amount: 700, at: ESCROW }],
      referenceHolders: [ESCROW],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'MOVE',
              from: ESCROW,
              to: BUYER,
              tokens: [{ currency: 'PAID_POINT', amount: 300, lotId: 41 }],
              reason: 'ORDER_UNSTAKE',
            },
          ],
          { closeAs: 'REVERSED' },
        ),
      ),
    ).toThrow(LedgerCloseNotEmptyError);
  });

  it('accepts a split: part back to the buyer, part on to the seller', () => {
    const world = buildWorld({
      state: 'FUNDED',
      lots: [{ id: 42, currency: 'PAID_POINT', ownerUserId: 1, amount: 1_000, at: ESCROW }],
      referenceHolders: [ESCROW],
    });
    const result = plan(
      world,
      post(
        [
          {
            op: 'MOVE',
            from: ESCROW,
            to: BUYER,
            tokens: [{ currency: 'PAID_POINT', amount: 500, lotId: 42 }],
            reason: 'ORDER_UNSTAKE',
          },
          {
            op: 'SWAP',
            from: ESCROW,
            to: SELLER,
            tokens: [{ currency: 'PAID_POINT', amount: 500, lotId: 42 }],
            rate: 'SETTLE',
          },
        ],
        { closeAs: 'SPLIT' },
      ),
    );
    expect(result.reference).toMatchObject({ nextState: 'CLOSED', closeReason: 'SPLIT' });
  });

  it('reserves VOID for a flow where nothing ever moved', () => {
    const world = buildWorld({ referenceId: 'CH-0000000001' });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'MINT',
              to: BUYER,
              target: { currency: 'PAID_POINT', amount: 10, source: 'PG' },
              reason: 'PG_CHARGE',
            },
          ],
          { referenceId: 'CH-0000000001', closeAs: 'VOID' },
        ),
      ),
    ).toThrow(LedgerVoidNotEmptyError);

    // With no operations at all it is exactly what VOID means.
    expect(
      plan(world, post([], { referenceId: 'CH-0000000001', closeAs: 'VOID' })).reference,
    ).toMatchObject({ nextState: 'CLOSED', closeReason: 'VOID' });
  });

  it('refuses VOID on a flow that was funded by an EARLIER posting', () => {
    // FUNDED means value has already moved under this flow, so calling it an
    // abandoned checkout is a lie even when THIS posting moves nothing.
    const funded = buildWorld({ referenceId: 'CH-0000000001', state: 'FUNDED' });
    expect(() =>
      plan(funded, post([], { referenceId: 'CH-0000000001', closeAs: 'VOID' })),
    ).toThrow(LedgerVoidNotEmptyError);
  });

  it('refuses to touch an escrow that belongs to a different flow', () => {
    // The hole this closes: staking into another order's escrow puts value
    // where THIS flow's emptiness check cannot see it and where that flow —
    // possibly already closed — is the only one that could ever free it.
    const world = buildWorld({
      lots: [{ id: 70, currency: 'PAID_POINT', ownerUserId: 1, amount: 500, at: BUYER }],
    });
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: escrowHolder('OR-0000000002'),
            tokens: [{ currency: 'PAID_POINT', amount: 500, lotId: 70 }],
            reason: 'ORDER_STAKE',
          },
        ]),
      ),
    ).toThrow(LedgerForeignHolderError);

    // Its own escrow is fine — the rule is ownership, not the holder kind.
    expect(() =>
      plan(
        world,
        post([
          {
            op: 'MOVE',
            from: BUYER,
            to: ESCROW,
            tokens: [{ currency: 'PAID_POINT', amount: 500, lotId: 70 }],
            reason: 'ORDER_STAKE',
          },
        ]),
      ),
    ).not.toThrow();
  });

  it('refuses a payable belonging to a different flow, the same way', () => {
    const world = buildWorld({
      referenceId: 'PO-0000000002',
      scalars: [{ holder: BUYER, currency: 'INCOME', amount: 50_000 }],
    });
    expect(() =>
      plan(
        world,
        post(
          [
            {
              op: 'MOVE',
              from: BUYER,
              to: PAYABLE, // anchored to PAYOUT_REF, not to this flow
              tokens: [{ currency: 'INCOME', amount: 50_000, lotId: null }],
              reason: 'PAYOUT_STAKE',
            },
          ],
          { referenceId: 'PO-0000000002' },
        ),
      ),
    ).toThrow(LedgerForeignHolderError);
  });
});

describe('planPosting — the payout floor', () => {
  it('refuses a payout smaller than the policy will send', () => {
    const world = buildWorld({
      referenceId: PAYOUT_REF,
      scalars: [{ holder: BUYER, currency: 'INCOME', amount: 8_000 }],
    });
    const payout = (amount: number) =>
      post(
        [
          {
            op: 'MOVE',
            from: BUYER,
            to: PAYABLE,
            tokens: [{ currency: 'INCOME', amount, lotId: null }],
            reason: 'PAYOUT_STAKE',
          },
        ],
        { referenceId: PAYOUT_REF },
      );

    // Refused where the value leaves the wallet, not later at the bank burn:
    // nobody should watch money sit in a payable that could never be sent.
    expect(() => plan(world, payout(8_000))).toThrow(LedgerBelowPayoutMinimumError);

    const enough = buildWorld({
      referenceId: PAYOUT_REF,
      scalars: [{ holder: BUYER, currency: 'INCOME', amount: 9_000 }],
    });
    expect(() => plan(enough, payout(9_000))).not.toThrow();
  });
});

describe('planPosting — a clawback that cannot be fully recovered', () => {
  it('parks the unrecoverable part on a receivable rather than overdrawing a wallet', () => {
    const world = buildWorld({
      referenceId: 'AD-0000000001',
      lots: [{ id: 50, currency: 'PAID_POINT', ownerUserId: 1, amount: 400, at: BUYER }],
    });
    const result = plan(
      world,
      post(
        [
          {
            op: 'MOVE',
            from: BUYER,
            to: receivableHolder(1),
            tokens: [{ currency: 'PAID_POINT', amount: 400, lotId: 50 }],
            reason: 'CLAWBACK',
          },
          {
            op: 'MINT',
            to: receivableHolder(1),
            target: { currency: 'PAID_POINT', amount: 600, source: 'ADMIN' },
            reason: 'LOSS_RECOGNITION',
          },
        ],
        { referenceId: 'AD-0000000001', closeAs: 'SETTLED' },
      ),
    );
    const receivable = result.balanceWrites.find(
      (write) => write.holderKey === holderKey(receivableHolder(1)),
    );
    expect(receivable).toMatchObject({ after: 1_000 });
    // The wallet went to zero, never below it.
    expect(result.balanceWrites.every((write) => write.after >= 0)).toBe(true);
  });
});

const holding = (id: number, amount: number, validUntil: Date, source: 'PG' | 'IAP' = 'PG') => ({
  lot: {
    id,
    currency: 'PAID_POINT' as const,
    ownerUserId: 1,
    source,
    originalAmount: amount,
    validUntil,
    cancellableUntil: null,
  },
  amount,
});

describe('selectLotsFifo', () => {
  it('drains the lot that dies first, so value does not expire in a full wallet', () => {
    const tokens = selectLotsFifo(
      [
        holding(1, 100, FAR_FUTURE),
        holding(2, 100, SOON),
        holding(3, 100, new Date('2027-01-01T00:00:00.000Z')),
      ],
      'PAID_POINT',
      150,
    );
    expect(tokens).toEqual([
      { currency: 'PAID_POINT', amount: 100, lotId: 2 },
      { currency: 'PAID_POINT', amount: 50, lotId: 3 },
    ]);
  });

  it('skips the sources a payout may not touch, without spending them', () => {
    const tokens = selectLotsFifo(
      [holding(1, 100, SOON, 'IAP'), holding(2, 100, FAR_FUTURE, 'PG')],
      'PAID_POINT',
      100,
      { excludeSources: ['IAP'] },
    );
    expect(tokens).toEqual([{ currency: 'PAID_POINT', amount: 100, lotId: 2 }]);
  });

  it('returns nothing rather than a partial selection', () => {
    expect(() => selectLotsFifo([holding(1, 100, SOON)], 'PAID_POINT', 101)).toThrow(
      LedgerInsufficientBalanceError,
    );
  });
});

describe('redeemFee', () => {
  it('takes the rate, but never less than the floor', () => {
    const policy = currencyRegistry.PAID_POINT.redeem!;
    expect(redeemFee(policy, 100_000)).toBe(10_000);
    // 10% of 5,000 is 500, which is below the 1,000 floor.
    expect(redeemFee(policy, 5_000)).toBe(1_000);
  });

  it('rounds the fee up, so rounding never favours the payer', () => {
    expect(redeemFee(currencyRegistry.PAID_POINT.redeem!, 10_001)).toBe(1_001);
  });
});

describe('holdersOf', () => {
  it('names every account a posting will touch, including a rebate target', () => {
    const holders = holdersOf([
      {
        op: 'SWAP',
        from: ESCROW,
        to: SELLER,
        tokens: [{ currency: 'PAID_POINT', amount: 1, lotId: 1 }],
        rate: 'SETTLE',
        rebateTo: BUYER,
      },
    ]);
    expect(holders.map(holderKey).toSorted()).toEqual(['ESCROW:OR-0000000001', 'USER:1', 'USER:2']);
  });
});
