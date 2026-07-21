import { InMemoryProvider } from '@openfeature/server-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// The feature-flag mechanism end to end, gating transferPoint. Two apps on one
// test database: one whose gate is forced OFF by the SDK's InMemoryProvider, and
// one wired to the REAL DB-backed provider at stage PROD so flags are driven by
// FeatureFlag rows through the admin service (the crepe loop).
const prisma = await makeTestPrisma();

const offApp = buildApp({
  prisma,
  logger: false,
  flagProvider: new InMemoryProvider({
    pointTransfer: { variants: { on: true, off: false }, defaultVariant: 'off', disabled: false },
  }),
});
const dbApp = buildApp({ prisma, logger: false, stage: 'PROD' });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: Record<string, any> }>;
}

function gqlVia(app: FastifyInstance) {
  return async (query: string): Promise<GqlResult> => {
    const res = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query }),
    });
    return res.json() as GqlResult;
  };
}
const offGql = gqlVia(offApp.app);
const dbGql = gqlVia(dbApp.app);

beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await offApp.app.close();
  await dbApp.app.close();
  await prisma.$disconnect();
});

async function fundedPair(gql: (q: string) => Promise<GqlResult>): Promise<{ from: number; to: number }> {
  const a = await gql('mutation { signUp(input: { email: "ff-a@x.com" }) { id } }');
  const b = await gql('mutation { signUp(input: { email: "ff-b@x.com" }) { id } }');
  const from = Number(a.data?.signUp.id);
  const to = Number(b.data?.signUp.id);
  await gql(`mutation { chargePoint(input: { userId: ${from}, paidAmount: 100, freeAmount: 0 }) { id } }`);
  return { from, to };
}
const transferMut = (from: number, to: number, amount: number): string =>
  `mutation { transferPoint(input: { fromUserId: ${from}, toUserId: ${to}, amount: ${amount} }) { totalAmount } }`;

describe('feature flag gates transferPoint', () => {
  it('is UNAVAILABLE when the gate is off (InMemoryProvider), writing nothing', async () => {
    const { from, to } = await fundedPair(offGql);
    const res = await offGql(transferMut(from, to, 60));

    expect(res.data?.transferPoint).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAVAILABLE');
    const balance = await prisma.pointBalance.findUniqueOrThrow({ where: { userId: from } });
    expect(balance.totalAmount).toBe(100); // untouched — the gate throws before any write
  });

  it('crepe loop: a live PROD flag enables the transfer, soft-deleting it disables it again', async () => {
    const { from, to } = await fundedPair(dbGql);

    // No flag row yet → the DB provider fails the gate closed.
    let res = await dbGql(transferMut(from, to, 60));
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAVAILABLE');

    // Admin enables it for PROD (enableAfter in the past) via the admin service.
    const flag = await dbApp.services.featureFlag.upsert({
      name: 'pointTransfer',
      stage: 'PROD',
      enableAfter: new Date(Date.now() - 1000),
    });
    res = await dbGql(transferMut(from, to, 60));
    expect(res.errors).toBeUndefined();
    expect(res.data?.transferPoint?.totalAmount).toBe(60);

    // Admin kills it → the gate closes; the next attempt writes nothing.
    await dbApp.services.featureFlag.remove(flag.id);
    res = await dbGql(transferMut(from, to, 10));
    expect(res.data?.transferPoint).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('UNAVAILABLE');
  });
});
