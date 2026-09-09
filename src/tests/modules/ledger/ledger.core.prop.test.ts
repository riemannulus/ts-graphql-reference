import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import { currencyRegistry } from '../../../modules/ledger/currencies/registry.core.js';
import {
  type BalanceWrite,
  holdersOf,
  LedgerConservationError,
  LedgerInsufficientBalanceError,
  LedgerLotCoherenceError,
  type Op,
  planPosting,
  type PostingPlan,
  selectLotsFifo,
  SWAP_RATES,
  type Token,
} from '../../../modules/ledger/ledger.core.js';
import {
  escrowHolder,
  holderKey,
  isLottedCurrency,
  mintReferenceId,
  parseHolderKey,
  parseReferenceKind,
  REFERENCE_ID_ALPHABET,
  REFERENCE_ID_SUFFIX_LENGTH,
  REFERENCE_KINDS,
  userHolder,
} from '../../../modules/ledger/ledger.value.js';
import { arbMoveAmount, arbWallet, buildWorld, NOW, ORDER_REF } from './ledger.arbitraries.js';

// The ledger's laws. Each property runs against hundreds of random coherent
// wallets, with no database involved — which is the entire reason the decision
// is a pure function.

const ESCROW = escrowHolder(ORDER_REF);
const SELLER = userHolder(2);

const isDomainRejection = (error: unknown) =>
  typeof error === 'object' && error !== null && 'isDomainError' in error;

/**
 * Plans, or reports that the kernel refused. A refusal is fine — a random amount
 * may exceed the wallet. What must NEVER happen on a coherent world is one of
 * the masked corruption errors: those say the kernel itself computed something
 * impossible.
 */
function plannedOrRejected(
  world: Parameters<typeof planPosting>[0],
  ops: readonly Op[],
  closeAs?: 'SETTLED' | 'REVERSED' | 'SPLIT',
): PostingPlan | 'rejected' {
  try {
    return planPosting(
      world,
      {
        referenceId: ORDER_REF,
        idempotencyKey: 'prop',
        actor: { kind: 'SYSTEM', id: null },
        ops,
        closeAs,
      },
      currencyRegistry,
      NOW,
    );
  } catch (error) {
    if (error instanceof LedgerConservationError || error instanceof LedgerLotCoherenceError) {
      throw error; // a coherent world must never reach the corruption path
    }
    if (isDomainRejection(error)) return 'rejected';
    throw error;
  }
}

/** The net change a plan makes to one currency's total across all holders. */
function supplyDelta(writes: readonly BalanceWrite[]): number {
  return writes.reduce((sum, write) => sum + write.after - (write.assumed ?? 0), 0);
}

function stakeOps(tokens: readonly Token[]): Op[] {
  return [{ op: 'MOVE', from: userHolder(1), to: ESCROW, tokens, reason: 'ORDER_STAKE' }];
}

test.prop([arbWallet, arbMoveAmount])(
  'law L1 — a move conserves the currency: what one account loses, another gains',
  (wallet, amount) => {
    fc.pre(amount <= wallet.total);
    const world = buildWorld({ lots: wallet.lots, referenceHolders: [ESCROW] });
    const tokens = selectLotsFifo(
      wallet.lots.map((lot) => ({
        lot: world.lots.find((row) => row.id === lot.id)!,
        amount: lot.amount,
      })),
      wallet.currency,
      amount,
    );
    const plan = plannedOrRejected(world, stakeOps(tokens));
    expect(plan).not.toBe('rejected');
    expect(supplyDelta((plan as PostingPlan).balanceWrites)).toBe(0);
  },
);

test.prop([arbWallet, arbMoveAmount])(
  'law L6 — no plan ever leaves an account holding less than nothing',
  (wallet, amount) => {
    const world = buildWorld({ lots: wallet.lots, referenceHolders: [ESCROW] });
    let tokens: readonly Token[];
    try {
      tokens = selectLotsFifo(
        wallet.lots.map((lot) => ({
          lot: world.lots.find((row) => row.id === lot.id)!,
          amount: lot.amount,
        })),
        wallet.currency,
        amount,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerInsufficientBalanceError);
      return; // the selection refused, so there is no plan to check
    }
    const plan = plannedOrRejected(world, stakeOps(tokens));
    if (plan === 'rejected') return;
    expect(plan.balanceWrites.every((write) => write.after >= 0)).toBe(true);
    expect(plan.lotBalanceWrites.every((write) => write.after >= 0)).toBe(true);
  },
);

test.prop([arbWallet, arbMoveAmount])(
  'law L4 — a stake and its unstake return the very same lots, amount for amount',
  (wallet, amount) => {
    fc.pre(amount <= wallet.total);
    const world = buildWorld({ lots: wallet.lots, referenceHolders: [ESCROW] });
    const tokens = selectLotsFifo(
      wallet.lots.map((lot) => ({
        lot: world.lots.find((row) => row.id === lot.id)!,
        amount: lot.amount,
      })),
      wallet.currency,
      amount,
    );

    const staked = plannedOrRejected(world, stakeOps(tokens)) as PostingPlan;
    // Roll the staked world forward and move everything back.
    const afterStake = buildWorld({
      lots: [
        ...wallet.lots.map((lot) => {
          const moved = tokens.find((token) => token.lotId === lot.id)?.amount ?? 0;
          return { ...lot, amount: lot.amount - moved };
        }),
        ...tokens.map((token) => ({
          id: token.lotId!,
          currency: wallet.currency,
          ownerUserId: 1,
          amount: token.amount,
          at: ESCROW,
        })),
      ].filter((lot) => lot.amount > 0),
      state: 'FUNDED',
      referenceHolders: [ESCROW],
    });
    const returned = plannedOrRejected(
      afterStake,
      [{ op: 'MOVE', from: ESCROW, to: userHolder(1), tokens, reason: 'ORDER_UNSTAKE' }],
      'REVERSED',
    ) as PostingPlan;

    expect(staked.lotsToCreate).toHaveLength(0);
    expect(returned.lotsToCreate).toHaveLength(0);
    const backToWallet = returned.lotBalanceWrites.filter(
      (write) => write.holderKey === 'USER:1',
    );
    for (const token of tokens) {
      const write = backToWallet.find(
        (candidate) =>
          candidate.lot.kind === 'EXISTING' && candidate.lot.lotId === token.lotId,
      );
      expect(write!.after - (write!.assumed ?? 0)).toBe(token.amount);
    }
  },
);

test.prop([arbWallet, arbMoveAmount])(
  'law L2 — a swap creates exactly what it destroyed, less the fee, and rebates that fee',
  (wallet, amount) => {
    fc.pre(amount <= wallet.total);
    const world = buildWorld({
      state: 'FUNDED',
      lots: wallet.lots.map((lot) => ({ ...lot, at: ESCROW })),
      referenceHolders: [ESCROW],
    });
    const tokens = selectLotsFifo(
      wallet.lots.map((lot) => ({
        lot: world.lots.find((row) => row.id === lot.id)!,
        amount: lot.amount,
      })),
      wallet.currency,
      amount,
    );
    const plan = plannedOrRejected(world, [
      { op: 'SWAP', from: ESCROW, to: SELLER, tokens, rate: 'SETTLE' },
    ]);
    if (plan === 'rejected') return; // a fee that eats the whole exchange

    const swap = plan.swapsToCreate[0]!;
    const burned = plan.events
      .filter((event) => event.op === 'SWAP_BURN')
      .reduce((sum, event) => sum + event.amount, 0);
    const minted = plan.events.filter((event) => event.op === 'SWAP_MINT');
    const income = minted.find((event) => event.currency === 'INCOME')!;
    const rebate = minted.find((event) => event.currency === 'MILEAGE');

    expect(burned).toBe(amount);
    expect(income.amount + swap.feeKrw).toBe(burned);
    expect(rebate?.amount ?? 0).toBe(swap.feeKrw);
    // The fee is exactly the rate, rounded the payer's way.
    expect(swap.feeKrw).toBe(Math.floor((burned * SWAP_RATES.SETTLE.feePermille) / 1000));
    // And rounding down is what makes every exchange representable: whatever a
    // SPLIT leaves behind, settling it mints at least one unit.
    expect(income.amount).toBeGreaterThan(0);
  },
);

test.prop([arbWallet, arbMoveAmount])(
  'FIFO selection: the tokens sum to the request, in deadline order, never over a lot',
  (wallet, amount) => {
    const world = buildWorld({ lots: wallet.lots });
    const holdings = wallet.lots.map((lot) => ({
      lot: world.lots.find((row) => row.id === lot.id)!,
      amount: lot.amount,
    }));
    let tokens: Token[];
    try {
      tokens = selectLotsFifo(holdings, wallet.currency, amount);
    } catch {
      expect(amount).toBeGreaterThan(wallet.total);
      return;
    }
    expect(tokens.reduce((sum, token) => sum + token.amount, 0)).toBe(amount);
    for (const token of tokens) {
      const held = holdings.find((holding) => holding.lot.id === token.lotId)!;
      expect(token.amount).toBeLessThanOrEqual(held.amount);
    }
    const deadlines = tokens.map(
      (token) => holdings.find((holding) => holding.lot.id === token.lotId)!.lot.validUntil,
    );
    expect(deadlines).toEqual(deadlines.toSorted((a, b) => a.getTime() - b.getTime()));
  },
);

test.prop([arbWallet])(
  'every operation names the accounts it touches, so the shell knows what to read',
  (wallet) => {
    const world = buildWorld({ lots: wallet.lots, referenceHolders: [ESCROW] });
    const tokens = selectLotsFifo(
      wallet.lots.map((lot) => ({
        lot: world.lots.find((row) => row.id === lot.id)!,
        amount: lot.amount,
      })),
      wallet.currency,
      wallet.total,
    );
    const ops = stakeOps(tokens);
    const declared = new Set(holdersOf(ops).map(holderKey));
    const plan = plannedOrRejected(world, ops) as PostingPlan;
    for (const write of plan.balanceWrites) expect(declared.has(write.holderKey)).toBe(true);
  },
);

// --- The vocabulary's two identities ---------------------------------------

const arbHolder = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }).map((userId) => userHolder(userId)),
  fc.integer({ min: 1, max: 1_000_000 }).map((userId) => ({
    kind: 'RECEIVABLE' as const,
    userId,
  })),
  fc
    .stringMatching(new RegExp(`^[${REFERENCE_ID_ALPHABET}]{${REFERENCE_ID_SUFFIX_LENGTH}}$`))
    .map((suffix) => escrowHolder(mintReferenceId('ORDER', suffix))),
  fc
    .stringMatching(new RegExp(`^[${REFERENCE_ID_ALPHABET}]{${REFERENCE_ID_SUFFIX_LENGTH}}$`))
    .map((suffix) => ({ kind: 'PAYABLE' as const, referenceId: mintReferenceId('PAYOUT', suffix) })),
);

test.prop([arbHolder])('parseHolderKey is the exact inverse of holderKey', (holder) => {
  expect(parseHolderKey(holderKey(holder))).toEqual(holder);
});

test.prop([
  fc.constantFrom(...REFERENCE_KINDS),
  fc.stringMatching(new RegExp(`^[${REFERENCE_ID_ALPHABET}]{${REFERENCE_ID_SUFFIX_LENGTH}}$`)),
])('a reference id carries its own kind, readably', (kind, suffix) => {
  const id = mintReferenceId(kind, suffix);
  expect(parseReferenceKind(id)).toBe(kind);
  // Two letters, a dash, then the suffix — short enough to read down a phone.
  expect(id).toHaveLength(3 + REFERENCE_ID_SUFFIX_LENGTH);
});

test('the currency graph has no edge out of the loyalty currency', () => {
  const outgoing = Object.values(SWAP_RATES).filter((rate) =>
    (rate.from as readonly string[]).includes('MILEAGE'),
  );
  expect(outgoing).toEqual([]);
  // And nothing lotted is ever minted without a source to mint it from.
  for (const rate of Object.values(SWAP_RATES)) {
    if (isLottedCurrency(rate.to)) expect(rate.mintLotSource).not.toBeNull();
  }
});
