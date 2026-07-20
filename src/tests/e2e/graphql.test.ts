import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Inject a test-DB-backed client; buildApp uses it as both rw and ro.
const prisma = await makeTestPrisma();
const { app } = buildApp({ prisma, logger: false });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: Record<string, any> }>;
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
  await prisma.$disconnect(); // injected clients stay the injector's to manage
});

describe('GraphQL API', () => {
  it('signUp creates a user with a welcome post', async () => {
    const res = await gql(
      'mutation ($e: String!) { signUp(input: { email: $e, name: "Alice" }) { id email posts { title } } }',
      { e: 'a@b.com' },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.signUp.email).toBe('a@b.com');
    expect(res.data?.signUp.posts).toHaveLength(1);
    expect(res.data?.signUp.posts[0].title).toBe('Welcome!');
  });

  it('createUser is not a schema field (signUp is the only way in)', async () => {
    const res = await gql('mutation { createUser(input: { email: "z@z.com" }) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/createUser/);
  });

  it('surfaces a duplicate sign-up as the expected domain error', async () => {
    await gql('mutation { signUp(input: { email: "dup@q.com" }) { id } }');
    const res = await gql('mutation { signUp(input: { email: "dup@q.com" }) { id } }');
    expect(res.data?.signUp).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('EMAIL_TAKEN');
  });

  it('surfaces an illegal status transition as a domain error', async () => {
    const created = await gql('mutation { signUp(input: { email: "x@y.com" }) { id } }');
    const id = Number(created.data?.signUp.id);

    await gql(`mutation { changeUserStatus(id: ${id}, status: DEACTIVATED) { status } }`);
    const res = await gql(`mutation { changeUserStatus(id: ${id}, status: ACTIVE) { status } }`);

    expect(res.data?.changeUserStatus).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('charges and spends points through the full stack', async () => {
    const created = await gql('mutation { signUp(input: { email: "p@q.com" }) { id } }');
    const id = Number(created.data?.signUp.id);

    const charged = await gql(
      `mutation { chargePoint(input: { userId: ${id}, paidAmount: 100, freeAmount: 30 }) { state unspentPaidAmount user { email } } }`,
    );
    expect(charged.errors).toBeUndefined();
    expect(charged.data?.chargePoint).toMatchObject({
      state: 'USABLE',
      unspentPaidAmount: 100,
      user: { email: 'p@q.com' },
    });

    const spent = await gql(
      `mutation { spendPoint(input: { userId: ${id}, amount: 120, reason: "checkout" }) { paidAmount freeAmount totalAmount } }`,
    );
    expect(spent.errors).toBeUndefined();
    // Paid-first split: all 100 paid before free points are touched.
    expect(spent.data?.spendPoint).toMatchObject({
      paidAmount: 100,
      freeAmount: 20,
      totalAmount: 120,
    });

    const balance = await gql(`query { pointBalance(userId: ${id}) { totalAmount freeAmount } }`);
    expect(balance.data?.pointBalance).toMatchObject({ totalAmount: 10, freeAmount: 10 });
  });

  it('surfaces an over-balance spend as a domain error', async () => {
    const created = await gql('mutation { signUp(input: { email: "poor@q.com" }) { id } }');
    const id = Number(created.data?.signUp.id);

    const res = await gql(
      `mutation { spendPoint(input: { userId: ${id}, amount: 1, reason: "x" }) { id } }`,
    );
    expect(res.data?.spendPoint).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('INSUFFICIENT_POINT');
  });

  it('transfers points between two users through the full stack', async () => {
    const alice = await gql('mutation { signUp(input: { email: "alice@t.com" }) { id } }');
    const bob = await gql('mutation { signUp(input: { email: "bob@t.com" }) { id } }');
    const aliceId = Number(alice.data?.signUp.id);
    const bobId = Number(bob.data?.signUp.id);
    await gql(
      `mutation { chargePoint(input: { userId: ${aliceId}, paidAmount: 100, freeAmount: 0 }) { id } }`,
    );

    const res = await gql(
      `mutation { transferPoint(input: { fromUserId: ${aliceId}, toUserId: ${bobId}, amount: 60 }) { paidAmount totalAmount user { email } } }`,
    );
    expect(res.errors).toBeUndefined();
    // The returned record is the sender's spend.
    expect(res.data?.transferPoint).toMatchObject({
      paidAmount: 60,
      totalAmount: 60,
      user: { email: 'alice@t.com' },
    });

    const aliceBalance = await gql(`query { pointBalance(userId: ${aliceId}) { totalAmount } }`);
    const bobBalance = await gql(`query { pointBalance(userId: ${bobId}) { totalAmount } }`);
    expect(aliceBalance.data?.pointBalance.totalAmount).toBe(40);
    expect(bobBalance.data?.pointBalance.totalAmount).toBe(60);
  });

  it('surfaces a transfer to self as a domain error', async () => {
    const created = await gql('mutation { signUp(input: { email: "solo@t.com" }) { id } }');
    const id = Number(created.data?.signUp.id);
    await gql(`mutation { chargePoint(input: { userId: ${id}, paidAmount: 50, freeAmount: 0 }) { id } }`);

    const res = await gql(
      `mutation { transferPoint(input: { fromUserId: ${id}, toUserId: ${id}, amount: 10 }) { id } }`,
    );
    expect(res.data?.transferPoint).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('POINT_TRANSFER_TO_SELF');
  });
});
