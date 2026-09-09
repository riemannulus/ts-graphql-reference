import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createServices } from '../../services.js';
import { fixedClock } from '../support/clock.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';
import { NOW, sequentialRandom } from '../modules/ledger/ledger.arbitraries.js';
import { escrowHolder, userHolder } from '../../modules/ledger/ledger.value.js';

// The ledger's READ surface through the whole app. The kernel's laws are proven
// in modules/ledger/; what this file proves is that a person can actually see
// their own money afterwards — and that there is no way to move it from here.
const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };
const { app } = buildApp({ prisma, logger: false });
// A second container over the same database, so the test can MAKE money the way
// a domain would (through the service) and then READ it the way a client does.
const services = createServices(db, { clock: fixedClock(NOW), random: sequentialRandom() });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string }>;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json() as GqlResult;
}

beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Tops a person up and stakes half of it into an order, as a domain would. */
async function moneyFor(email: string) {
  const user = await prisma.user.create({ data: { email } });
  const charge = await services.ledger.openReference({ kind: 'CHARGE', initiatorUserId: user.id });
  const minted = await services.ledger.post({
    referenceId: charge.id,
    idempotencyKey: `${charge.id}:mint`,
    actor: { kind: 'USER', id: String(user.id) },
    ops: [
      {
        op: 'MINT',
        to: userHolder(user.id),
        target: { currency: 'PAID_POINT', amount: 10_000, source: 'PG' },
        reason: 'PG_CHARGE',
      },
    ],
    closeAs: 'SETTLED',
  });

  const order = await services.ledger.openReference({ kind: 'ORDER' });
  await services.ledger.post({
    referenceId: order.id,
    idempotencyKey: `${order.id}:stake`,
    actor: { kind: 'USER', id: String(user.id) },
    ops: [
      {
        op: 'MOVE',
        from: userHolder(user.id),
        to: escrowHolder(order.id),
        tokens: [{ currency: 'PAID_POINT', amount: 4_000, lotId: minted.mintedLotIds[0]! }],
        reason: 'ORDER_STAKE',
      },
    ],
  });
  return { userId: user.id, chargeId: charge.id, orderId: order.id };
}

describe('the ledger over GraphQL', () => {
  it('shows a person what they hold, and the lots in the order they will be spent', async () => {
    const { userId } = await moneyFor('reader@example.com');

    const res = await gql(
      `query ($id: Int!) {
        ledgerBalances(userId: $id) { currency amount }
        ledgerLotHoldings(userId: $id, currency: PAID_POINT) {
          amount
          lot { source validUntil }
        }
      }`,
      { id: userId },
    );

    expect(res.errors).toBeUndefined();
    // Staked value has left the wallet: it is in the order, not spent.
    expect(res.data?.ledgerBalances).toEqual([{ currency: 'PAID_POINT', amount: 6_000 }]);
    expect(res.data?.ledgerLotHoldings).toEqual([
      { amount: 6_000, lot: { source: 'PG', validUntil: expect.any(String) } },
    ]);
  });

  it('tells the whole story of one flow from the id a person can quote', async () => {
    const { orderId } = await moneyFor('flow@example.com');

    const res = await gql(
      `query ($id: String!) {
        ledgerReference(id: $id) {
          id
          kind
          state
          closeReason
          holders { key kind }
        }
        ledgerReferenceEvents(referenceId: $id) { op currency amount reason }
      }`,
      { id: orderId },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.ledgerReference).toMatchObject({
      id: orderId,
      kind: 'ORDER',
      state: 'FUNDED',
      closeReason: null,
    });
    // The escrow is the order's own account, named after the order.
    expect(res.data?.ledgerReference.holders).toContainEqual({
      key: `ESCROW:${orderId}`,
      kind: 'ESCROW',
    });
    expect(res.data?.ledgerReferenceEvents).toEqual([
      { op: 'MOVE', currency: 'PAID_POINT', amount: 4_000, reason: 'ORDER_STAKE' },
    ]);
  });

  it('reads a statement newest-first, one page at a time', async () => {
    const { userId } = await moneyFor('statement@example.com');

    const page = await gql(
      'query ($id: Int!) { ledgerHolderEvents(userId: $id) { seq op reason } }',
      { id: userId },
    );
    expect(page.errors).toBeUndefined();
    const events = page.data?.ledgerHolderEvents as Array<{ seq: string; reason: string }>;
    // The mint and the stake, most recent first — one list across both flows.
    expect(events.map((event) => event.reason)).toEqual(['ORDER_STAKE', 'PG_CHARGE']);

    const older = await gql(
      'query ($id: Int!, $before: Int!) { ledgerHolderEvents(userId: $id, before: $before) { reason } }',
      { id: userId, before: Number(events[0]!.seq) },
    );
    expect(older.data?.ledgerHolderEvents).toEqual([{ reason: 'PG_CHARGE' }]);
  });

  it('offers no way to move value: the ledger is read-only from outside', async () => {
    const res = await gql('mutation { ledgerPost(input: {}) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/ledgerPost/);

    // And the schema carries no ledger mutation under any other name either.
    const introspection = await gql('{ mutationType: __type(name: "Mutation") { fields { name } } }');
    const fields = introspection.data?.mutationType.fields as Array<{ name: string }>;
    expect(fields.filter((field) => field.name.toLowerCase().includes('ledger'))).toEqual([]);
  });
});
