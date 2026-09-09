import type { LedgerEvent } from '@prisma/client';
import type { DbClient, ReadDbClient } from '../../db/db.js';
import { isUniqueViolation } from '../../db/prisma-errors.js';
import { ConcurrentUpdateError } from '../../foundation/errors.js';
import { LedgerReferenceNotFoundError } from './ledger.errors.core.js';
import type {
  BalanceRow,
  LedgerWorld,
  LotBalanceRow,
  LotPointer,
  LotRow,
  PostingPlan,
} from './ledger.plan.core.js';
import type {
  StaleVoidPlan,
  TrialBalanceRow,
} from './ledger.sweep.core.js';
import {
  CURRENCIES,
  type Currency,
  type Holder,
  holderKey,
  parseCurrency,
  parseHolderKey,
  parseLotSource,
  parseLottedCurrency,
  parseReferenceState,
} from './ledger.value.js';

/**
 * Ledger persistence, write path — the world loader and the plan executor.
 *
 * Shaped by USE CASE, not by table: `applyPostingPlan` deliberately writes
 * across six tables in one transaction, because that whole shape IS the unit of
 * work. Splitting it per model would scatter one atomic movement across files
 * and invite calling half of it.
 *
 * The load/apply pair is the whole file. `loadLedgerWorld` reads the world the
 * kernel decides on; `applyPostingPlan` mechanically executes the plan it
 * returned. There is no business branching here — every `if` that matters
 * happened in ledger.core.ts. The `if`s that remain are two mechanical kinds:
 * "does this row exist yet" (create vs guarded update) and "which id did the
 * row I just inserted get" (resolving a `LotPointer`).
 *
 * Which client a function runs on is ALWAYS the caller's choice, passed as the
 * first parameter. The reads here take `ReadDbClient` but belong to the write
 * path: they feed a DECISION inside a transaction, not a GraphQL projection —
 * those live in ledger.read.repo.ts.
 */

const ZERO_ROWS: never[] = [];

/**
 * Reads everything one posting decides against, in ONE snapshot: the flow's
 * lifecycle state, the balances and lot remainders of every holder the decision
 * touches, plus the flow's OWN escrow / payable accounts — the latter because
 * "is this flow finished?" (law L3) cannot be answered without them, even when
 * the posting itself never names them.
 *
 * MUST: run inside the deciding transaction at REPEATABLE READ (`uow.snapshot`).
 * Under READ COMMITTED each statement would get its own snapshot and a
 * concurrent movement landing between them would show the kernel a world that
 * never existed.
 */
export async function loadLedgerWorld(
  db: ReadDbClient,
  referenceId: string,
  holders: readonly Holder[],
): Promise<LedgerWorld> {
  const reference = await db.ledgerReference.findUnique({ where: { id: referenceId } });
  if (!reference) throw new LedgerReferenceNotFoundError(referenceId);

  const declaredKeys = holders.map(holderKey);
  // One query for both sets: the holders the decision named AND the ones this
  // flow owns. Sequential with the rest — Prisma transaction handles do not
  // support concurrent operations.
  const holderRows = await db.ledgerHolder.findMany({
    where: { OR: [{ key: { in: declaredKeys } }, { referenceId }] },
  });
  const knownHolderKeys = holderRows.map((row) => row.key);
  const referenceHolderKeys = holderRows
    .filter((row) => row.referenceId === referenceId)
    .map((row) => row.key);
  const keys = [...new Set([...declaredKeys, ...knownHolderKeys])];

  const balanceRows =
    keys.length === 0
      ? ZERO_ROWS
      : await db.ledgerBalance.findMany({ where: { holderKey: { in: keys } } });
  const lotBalanceRows =
    keys.length === 0
      ? ZERO_ROWS
      : await db.ledgerLotBalance.findMany({ where: { holderKey: { in: keys } } });
  const lotIds = [...new Set(lotBalanceRows.map((row) => row.lotId))];
  const lotRows =
    lotIds.length === 0 ? ZERO_ROWS : await db.ledgerLot.findMany({ where: { id: { in: lotIds } } });

  const balances: BalanceRow[] = balanceRows.map((row) => ({
    holderKey: row.holderKey,
    currency: parseCurrency(row.currency),
    amount: row.amount,
  }));
  const lotBalances: LotBalanceRow[] = lotBalanceRows.map((row) => ({
    lotId: row.lotId,
    holderKey: row.holderKey,
    amount: row.amount,
  }));
  const lots: LotRow[] = lotRows.map((row) => ({
    id: row.id,
    currency: parseLottedCurrency(row.currency),
    ownerUserId: row.ownerUserId,
    source: parseLotSource(row.source),
    originalAmount: row.originalAmount,
    validUntil: row.validUntil,
    cancellableUntil: row.cancellableUntil,
  }));

  return {
    reference: { id: reference.id, state: parseReferenceState(reference.state) },
    balances,
    lots,
    lotBalances,
    knownHolderKeys,
    referenceHolderKeys,
  };
}

/**
 * Executes a `PostingPlan`. Purely mechanical: the plan already carries every
 * decision, including the value each write must still observe.
 *
 * Every balance write is guarded by the plan's assumption (optimistic
 * concurrency): a row that moved after the world was read makes the guarded
 * update match nothing, and the `ConcurrentUpdateError` rolls the whole
 * transaction back rather than letting two movements both spend the same value.
 * A row the plan expected NOT to exist is created, so a concurrent creation
 * collides on the primary key and fails the same way.
 *
 * MUST: run inside the same transaction that `loadLedgerWorld` read in.
 */
export async function applyPostingPlan(
  db: DbClient,
  plan: PostingPlan,
): Promise<LedgerEvent[]> {
  if (plan.holdersToCreate.length > 0) {
    // `skipDuplicates`: a holder row is bookkeeping, not a claim. If a
    // concurrent posting created the same account first, that is fine — the
    // BALANCE guards below are what actually protect the money.
    await db.ledgerHolder.createMany({
      data: plan.holdersToCreate.map((holder) => ({
        key: holder.key,
        kind: holder.kind,
        userId: holder.userId,
        referenceId: holder.referenceId,
        createdAt: plan.now,
      })),
      skipDuplicates: true,
    });
  }

  // Lots and swaps are inserted first so the events that reference them have
  // their ids. Sequential `create` rather than `createMany`: a posting mints a
  // handful of rows and we need the ids back.
  const lotIds: number[] = [];
  for (const lot of plan.lotsToCreate) {
    // eslint-disable-next-line no-await-in-loop -- one insert per minted lot on a single tx handle
    const row = await db.ledgerLot.create({
      data: {
        currency: lot.currency,
        ownerUserId: lot.ownerUserId,
        mintReferenceId: plan.referenceId,
        source: lot.source,
        originalAmount: lot.originalAmount,
        mintedAt: lot.mintedAt,
        validUntil: lot.validUntil,
        cancellableUntil: lot.cancellableUntil,
      },
    });
    lotIds.push(row.id);
  }

  const swapIds: number[] = [];
  for (const swap of plan.swapsToCreate) {
    // eslint-disable-next-line no-await-in-loop -- one insert per exchange on a single tx handle
    const row = await db.ledgerSwap.create({
      data: {
        referenceId: plan.referenceId,
        rateKind: swap.rateKind,
        burnCurrency: swap.burnCurrency,
        mintCurrency: swap.mintCurrency,
        feePermille: swap.feePermille,
        feeKrw: swap.feeKrw,
      },
    });
    swapIds.push(row.id);
  }

  const resolveLot = (lot: LotPointer): number =>
    lot.kind === 'EXISTING' ? lot.lotId : lotIds[lot.ref]!;

  for (const write of plan.balanceWrites) {
    if (write.assumed === null) {
      // eslint-disable-next-line no-await-in-loop -- guarded writes run in plan order
      await db.ledgerBalance
        .create({
          data: {
            holderKey: write.holderKey,
            currency: write.currency,
            amount: write.after,
            updatedAt: plan.now,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new ConcurrentUpdateError(`balance ${write.holderKey}/${write.currency}`);
          }
          throw error;
        });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- guarded writes run in plan order
    const { count } = await db.ledgerBalance.updateMany({
      where: { holderKey: write.holderKey, currency: write.currency, amount: write.assumed },
      data: { amount: write.after, updatedAt: plan.now },
    });
    if (count !== 1) {
      throw new ConcurrentUpdateError(`balance ${write.holderKey}/${write.currency}`);
    }
  }

  for (const write of plan.lotBalanceWrites) {
    const lotId = resolveLot(write.lot);
    if (write.assumed === null) {
      // eslint-disable-next-line no-await-in-loop -- guarded writes run in plan order
      await db.ledgerLotBalance
        .create({ data: { lotId, holderKey: write.holderKey, amount: write.after } })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new ConcurrentUpdateError(`lot ${lotId} at ${write.holderKey}`);
          }
          throw error;
        });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- guarded writes run in plan order
    const { count } = await db.ledgerLotBalance.updateMany({
      where: { lotId, holderKey: write.holderKey, amount: write.assumed },
      data: { amount: write.after },
    });
    if (count !== 1) throw new ConcurrentUpdateError(`lot ${lotId} at ${write.holderKey}`);
  }

  const events: LedgerEvent[] = [];
  for (const event of plan.events) {
    // eslint-disable-next-line no-await-in-loop -- the append order IS the plan order
    const row = await db.ledgerEvent.create({
      data: {
        referenceId: plan.referenceId,
        idempotencyKey: plan.idempotencyKey,
        ordinal: event.ordinal,
        op: event.op,
        currency: event.currency,
        amount: event.amount,
        lotId: event.lot === null ? null : resolveLot(event.lot),
        fromHolderKey: event.fromHolderKey,
        toHolderKey: event.toHolderKey,
        reason: event.reason,
        swapId: event.swapRef === null ? null : swapIds[event.swapRef]!,
        feeKrw: event.feeKrw,
        externalRef: event.externalRef,
        actorKind: plan.actor.kind,
        actorId: plan.actor.id,
        createdAt: plan.now,
      },
    });
    events.push(row);
  }

  // The lifecycle move is guarded on the state the decision saw, so a flow
  // another request closed in the meantime cannot be reopened by this one.
  const { count } = await db.ledgerReference.updateMany({
    where: { id: plan.referenceId, state: plan.reference.assumedState },
    data: {
      state: plan.reference.nextState,
      closeReason: plan.reference.closeReason,
      closedAt: plan.reference.closedAt,
    },
  });
  if (count !== 1) throw new ConcurrentUpdateError(`reference ${plan.referenceId}`);

  return events;
}

/** Has this posting already landed? The replay check behind `idempotencyKey`. */
export function findPostingEvents(
  db: ReadDbClient,
  idempotencyKey: string,
): Promise<LedgerEvent[]> {
  return db.ledgerEvent.findMany({ where: { idempotencyKey }, orderBy: { ordinal: 'asc' } });
}

/** Creates the flow a posting will hang off. */
export function createReference(
  db: DbClient,
  input: {
    id: string;
    kind: string;
    parentId: string | null;
    initiatorUserId: number | null;
    expiresAt: Date | null;
    openedAt: Date;
  },
) {
  return db.ledgerReference.create({ data: { ...input, state: 'OPEN' } });
}

/**
 * Closes every OPEN flow whose window has passed, as VOID.
 *
 * A single guarded statement (concurrency ladder rung 0) and no posting at all,
 * because OPEN means — by the kernel's own transition rule — that nothing has
 * ever moved under it. The `state = 'OPEN'` predicate IS the proof, so a flow
 * that got funded a millisecond ago is skipped rather than raced with. The rows
 * are closed, never deleted: a webhook arriving late must still find the flow it
 * names.
 */
export async function applyStaleVoid(
  db: DbClient,
  plan: StaleVoidPlan,
): Promise<{ voidedCount: number }> {
  const { count } = await db.ledgerReference.updateMany({
    where: { state: plan.assumedState, expiresAt: { lte: plan.expiredBefore } },
    data: {
      state: plan.nextState,
      closeReason: plan.closeReason,
      closedAt: plan.closedAt,
    },
  });
  return { voidedCount: count };
}

/**
 * The WALLETS the expiry sweep has work in — not the work itself.
 *
 * Deliberately not "every lot past its deadline, with its amount". This read
 * runs before the posting's transaction, so an amount taken from it could be
 * stale by the time the plan is checked; it answers only "whose snapshot is
 * worth loading", and `selectDueLots` decides what to burn from that snapshot.
 *
 * Escrows are excluded here rather than by a branch downstream: value staked
 * into an unfinished flow must not be expired out from under a refund, so the
 * sweep never even loads those accounts.
 */
export async function findWalletsWithDueLots(
  db: ReadDbClient,
  now: Date,
  limit: number,
): Promise<Holder[]> {
  // `groupBy`, not `findMany({ distinct })`. Prisma applies `distinct` in the
  // client, so the emitted SQL carries no LIMIT and the whole expired-lot set is
  // materialized in Node before all but `limit` wallets are thrown away — which
  // is the opposite of what a batch cap is for. `groupBy` pushes both the
  // grouping and the limit into the query.
  const rows = await db.ledgerLotBalance.groupBy({
    by: ['holderKey'],
    where: {
      amount: { gt: 0 },
      lot: { validUntil: { lt: now } },
      holder: { kind: 'USER' },
    },
    orderBy: { holderKey: 'asc' },
    take: limit,
  });
  return rows.map((row) => parseHolderKey(row.holderKey));
}

/**
 * The books, both sides: what the event log says was minted and burned, and what
 * the balance rows say is held. Law L1 says they agree.
 *
 * Aggregated in the database rather than folded in memory — the event log only
 * grows, and a sweep that streams it would get slower forever.
 */
export async function loadTrialBalance(db: ReadDbClient): Promise<TrialBalanceRow[]> {
  const supply = await db.ledgerEvent.groupBy({
    by: ['currency', 'op'],
    _sum: { amount: true },
  });
  const held = await db.ledgerBalance.groupBy({ by: ['currency'], _sum: { amount: true } });

  const minted = new Map<Currency, number>();
  const burned = new Map<Currency, number>();
  for (const row of supply) {
    const currency = parseCurrency(row.currency);
    const amount = row._sum.amount ?? 0;
    const bucket = row.op === 'MINT' || row.op === 'SWAP_MINT' ? minted : burned;
    // A MOVE conserves value, so it belongs to neither side of the supply
    // equation — that is exactly what makes the comparison meaningful.
    if (row.op !== 'MOVE') bucket.set(currency, (bucket.get(currency) ?? 0) + amount);
  }
  const holdings = new Map<Currency, number>(
    held.map((row) => [parseCurrency(row.currency), row._sum.amount ?? 0]),
  );

  return CURRENCIES.map((currency) => ({
    currency,
    minted: minted.get(currency) ?? 0,
    burned: burned.get(currency) ?? 0,
    held: holdings.get(currency) ?? 0,
  }));
}
