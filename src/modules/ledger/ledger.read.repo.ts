import type { ReadDbClient, Selection } from '../../db/db.js';
import { holderKey } from './ledger.value.js';
import type { Currency, Holder } from './ledger.value.js';

/**
 * Ledger persistence, read path — projections for the GraphQL query layer.
 *
 * Every function has the same mechanical shape: accept the Pothos `query`
 * object (`select` / `include`) and spread it, so the plugin's relation-loading
 * optimization survives. The `query` parameter STOPS here — it is Prisma-shaped,
 * so the repo is where it belongs and services never see it.
 *
 * Everything takes `ReadDbClient` (write methods stripped at the type level).
 * Reads that feed a DECISION live with their executors in ledger.write.repo.ts.
 */

/** One holder's balances, one row per currency it has ever held. */
export function findBalances(
  db: ReadDbClient,
  holder: Holder,
  query: Selection<'LedgerBalance'> = {},
) {
  return db.ledgerBalance.findMany({
    orderBy: { currency: 'asc' },
    ...query,
    where: { holderKey: holderKey(holder) },
  });
}

/**
 * A person's live lot remainders for one currency, oldest deadline first — the
 * order value is spent in (`selectLotsFifo`), so the list a client renders and
 * the list the kernel drains are the same list.
 */
export function findLotHoldings(
  db: ReadDbClient,
  holder: Holder,
  currency: Currency,
  query: Selection<'LedgerLotBalance'> = {},
) {
  return db.ledgerLotBalance.findMany({
    orderBy: [{ lot: { validUntil: 'asc' } }, { lotId: 'asc' }],
    ...query,
    where: { holderKey: holderKey(holder), amount: { gt: 0 }, lot: { currency } },
  });
}

/** One flow, by the id a person can quote. */
export function findReference(
  db: ReadDbClient,
  id: string,
  query: Selection<'LedgerReference'> = {},
) {
  return db.ledgerReference.findUnique({ ...query, where: { id } });
}

/** A flow's movements, in the order they happened. */
export function findReferenceEvents(
  db: ReadDbClient,
  referenceId: string,
  query: Selection<'LedgerEvent'> = {},
) {
  return db.ledgerEvent.findMany({
    orderBy: { seq: 'asc' },
    ...query,
    where: { referenceId },
  });
}

/**
 * A person's movements, most recent first — every currency in one list, because
 * "what happened to my money" does not respect currency boundaries: a settlement
 * burns points and mints income, and showing one without the other is how a
 * statement stops adding up.
 */
export function findHolderEvents(
  db: ReadDbClient,
  holder: Holder,
  query: Selection<'LedgerEvent'> = {},
) {
  const key = holderKey(holder);
  return db.ledgerEvent.findMany({
    orderBy: { seq: 'desc' },
    ...query,
    where: { OR: [{ fromHolderKey: key }, { toHolderKey: key }] },
  });
}
