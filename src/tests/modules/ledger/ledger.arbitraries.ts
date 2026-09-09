import { fc } from '@fast-check/vitest';
import type {
  BalanceRow,
  LedgerWorld,
  LotBalanceRow,
  LotRow,
} from '../../../modules/ledger/ledger.core.js';
import type { Random } from '../../../foundation/random.js';
import {
  type Currency,
  type Holder,
  holderKey,
  REFERENCE_ID_ALPHABET,
  type LotSource,
  type LottedCurrency,
  type ReferenceState,
} from '../../../modules/ledger/ledger.value.js';

/**
 * Generators and fixtures for the ledger's laws.
 *
 * The interesting part is `buildWorld`: it derives the balance rows FROM the lot
 * remainders, so every world a property runs against is one a correct system
 * could actually be in. Feeding the kernel an incoherent world would only prove
 * that it notices — which the corruption tests do deliberately and separately.
 */

/**
 * A fixed reference instant. Deterministic given the fast-check seed (no
 * `Date.now()` in a generator), and the deadlines below sit on both sides of it
 * so one run exercises live lots, cancellable lots and expired ones.
 */
export const NOW = new Date('2026-06-01T00:00:00.000Z');
export const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');
export const FAR_FUTURE = new Date('2031-01-01T00:00:00.000Z');
export const SOON = new Date('2026-06-05T00:00:00.000Z');

export const ORDER_REF = 'OR-0000000001';
export const PAYOUT_REF = 'PO-0000000001';
export const GIFT_REF = 'GF-0000000001';
export const CHARGE_REF = 'CH-0000000001';

/** One lot with its remainder at a holder, as a test declares it. */
export interface LotSpecInput {
  readonly id: number;
  readonly currency: LottedCurrency;
  readonly ownerUserId: number;
  readonly amount: number;
  readonly at: Holder;
  readonly source?: LotSource;
  readonly originalAmount?: number;
  readonly validUntil?: Date;
  readonly cancellableUntil?: Date | null;
}

export interface BuildWorldInput {
  readonly referenceId?: string;
  readonly state?: ReferenceState;
  readonly lots?: readonly LotSpecInput[];
  /** Scalar-currency balances, which have no lots to derive from. */
  readonly scalars?: readonly { holder: Holder; currency: Currency; amount: number }[];
  /** Holders that already have a row; defaults to every holder mentioned. */
  readonly knownHolders?: readonly Holder[];
  readonly referenceHolders?: readonly Holder[];
}

/**
 * Assembles a coherent world: lot remainders plus the balances they sum to.
 * Deriving the balances rather than declaring them is what makes a fixture
 * impossible to write inconsistently by accident.
 */
export function buildWorld(input: BuildWorldInput = {}): LedgerWorld {
  const referenceId = input.referenceId ?? ORDER_REF;
  const lotInputs = input.lots ?? [];

  const lots: LotRow[] = lotInputs.map((lot) => ({
    id: lot.id,
    currency: lot.currency,
    ownerUserId: lot.ownerUserId,
    source: lot.source ?? 'PG',
    originalAmount: lot.originalAmount ?? lot.amount,
    validUntil: lot.validUntil ?? FAR_FUTURE,
    cancellableUntil: lot.cancellableUntil === undefined ? SOON : lot.cancellableUntil,
  }));

  const lotBalances: LotBalanceRow[] = lotInputs.map((lot) => ({
    lotId: lot.id,
    holderKey: holderKey(lot.at),
    amount: lot.amount,
  }));

  const totals = new Map<string, BalanceRow>();
  const add = (key: string, currency: Currency, amount: number) => {
    const cell = `${key}|${currency}`;
    const existing = totals.get(cell);
    totals.set(cell, {
      holderKey: key,
      currency,
      amount: (existing?.amount ?? 0) + amount,
    });
  };
  for (const lot of lotInputs) add(holderKey(lot.at), lot.currency, lot.amount);
  for (const scalar of input.scalars ?? []) add(holderKey(scalar.holder), scalar.currency, scalar.amount);

  const mentioned = new Set<string>([
    ...lotInputs.map((lot) => holderKey(lot.at)),
    ...(input.scalars ?? []).map((scalar) => holderKey(scalar.holder)),
  ]);

  return {
    reference: { id: referenceId, state: input.state ?? 'OPEN' },
    balances: [...totals.values()],
    lots,
    lotBalances,
    knownHolderKeys: input.knownHolders ? input.knownHolders.map(holderKey) : [...mentioned],
    referenceHolderKeys: (input.referenceHolders ?? []).map(holderKey),
  };
}

// --- Generators ------------------------------------------------------------

const MAX_AMOUNT = 10_000;

export const arbLottedCurrency: fc.Arbitrary<LottedCurrency> = fc.constantFrom(
  'PAID_POINT',
  'FREE_POINT',
);

/** Sources a lot may carry. `PG` is the only cancellable one, by policy. */
export const arbLotSource: fc.Arbitrary<LotSource> = fc.constantFrom(
  'PG',
  'IAP',
  'GIFT_CARD',
  'INCOME_SWAP',
  'ADMIN',
  'EVENT',
  'OPENING',
);

/**
 * A user's wallet: a handful of lots of ONE currency with positive remainders,
 * plus the world that holds them. One currency per world keeps the properties
 * about a single supply legible; mixing them is covered by the example tests.
 */
export const arbWallet = fc
  .record({
    currency: arbLottedCurrency,
    amounts: fc.array(fc.integer({ min: 1, max: MAX_AMOUNT }), { minLength: 1, maxLength: 6 }),
    sources: fc.array(arbLotSource, { minLength: 6, maxLength: 6 }),
  })
  .map(({ currency, amounts, sources }) => {
    const userId = 1;
    const lots: LotSpecInput[] = amounts.map((amount, index) => ({
      id: index + 1,
      currency,
      ownerUserId: userId,
      amount,
      at: { kind: 'USER', userId },
      source: sources[index] ?? 'PG',
      // Spread the deadlines so FIFO order is not the insertion order.
      validUntil: new Date(FAR_FUTURE.getTime() - index * 86_400_000),
    }));
    return {
      userId,
      currency,
      lots,
      total: amounts.reduce((sum, amount) => sum + amount, 0),
    };
  });

/** How much of a wallet to move — sometimes more than it holds. */
export const arbMoveAmount = fc.integer({ min: 1, max: MAX_AMOUNT * 7 });

/**
 * A deterministic `Random`: the bytes it hands back mint the suffixes
 * `0000000000`, `0000000001`, … so a test can name the reference it just made.
 *
 * It maps a counter through the id alphabet the same way the production binding
 * maps CSPRNG bytes, which is what makes it a stand-in for the seam rather than
 * a stand-in for the id.
 */
export function sequentialRandom(): Random {
  let next = 0;
  return {
    bytes: (count) => {
      const digits = String(next).padStart(count, '0');
      next += 1;
      return Uint8Array.from(digits, (digit) => REFERENCE_ID_ALPHABET.indexOf(digit));
    },
  };
}
