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
 *
 * BOTH event reads are PAGED, with a cursor, and the page size is decided here
 * rather than offered as an argument the caller may leave off. The log only
 * grows, so an unbounded read is a query that gets slower for the rest of its
 * life and a response that eventually will not serialize.
 *
 * A flow is capped for the same reason a person is, and not merely for
 * symmetry: one posting may carry hundreds of events — the expiry sweep writes
 * a burn per lot across a whole batch of wallets under a single `ADJUST`
 * reference — so "a flow is small" is not true of the flows this system
 * actually creates. A page with no cursor would drop the rest of a money log
 * silently, which is the worst way to lose it.
 */

/** The most rows any single event page returns. */
export const EVENT_PAGE_SIZE = 50;

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

/**
 * A flow's movements, in the order they happened, one page at a time. `after`
 * is the `seq` of the last row the caller already has — oldest-first here,
 * because a flow is read as a story rather than as a statement.
 */
export function findReferenceEvents(
  db: ReadDbClient,
  referenceId: string,
  after: number | null,
  query: Selection<'LedgerEvent'> = {},
) {
  return db.ledgerEvent.findMany({
    orderBy: { seq: 'asc' },
    ...query,
    where: { referenceId, ...(after === null ? {} : { seq: { gt: after } }) },
    take: EVENT_PAGE_SIZE,
  });
}

/**
 * A person's movements, most recent first — every currency in one list, because
 * "what happened to my money" does not respect currency boundaries: a settlement
 * burns points and mints income, and showing one without the other is how a
 * statement stops adding up.
 *
 * One page at a time, walked with `before` (the `seq` of the oldest row the
 * caller already has). A keyset cursor rather than an offset: the log is
 * append-only and read newest-first, so `seq < before` is an index range that
 * costs the same on page one and page a thousand.
 */
export function findHolderEvents(
  db: ReadDbClient,
  holder: Holder,
  before: number | null,
  query: Selection<'LedgerEvent'> = {},
) {
  const key = holderKey(holder);
  return db.ledgerEvent.findMany({
    orderBy: { seq: 'desc' },
    ...query,
    where: {
      OR: [{ fromHolderKey: key }, { toHolderKey: key }],
      ...(before === null ? {} : { seq: { lt: before } }),
    },
    take: EVENT_PAGE_SIZE,
  });
}
