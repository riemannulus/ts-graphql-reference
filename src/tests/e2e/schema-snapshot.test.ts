import { buildClientSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma } from '../support/helpers.js';

// Guards the assembled schema as a whole: schema.ts registers modules through
// explicit function calls, and these tests fail loudly if a register call is
// dropped (a module silently vanishing from the SDL) or a field changes
// unintentionally. Review snapshot diffs like code.
//
// The SDL comes from an introspection round-trip through the running app
// rather than printSchema(schema) directly: the schema object is built by
// Pothos' copy of `graphql` (the dual CJS/ESM package), and printing it with
// the test file's copy trips graphql's realm check.
const prisma = await makeTestPrisma();
const { app } = buildApp({ prisma, logger: false });

async function fetchSdl(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  const body = res.json() as { data: Parameters<typeof buildClientSchema>[0] };
  return printSchema(buildClientSchema(body.data));
}

afterAll(async () => {
  await app.close();
  await prisma.$disconnect(); // injected clients stay the injector's to manage
});

describe('GraphQL schema', () => {
  it('matches the committed SDL snapshot', async () => {
    expect(await fetchSdl()).toMatchSnapshot();
  });

  it('exposes every module root field', async () => {
    const sdl = await fetchSdl();
    for (const field of [
      'user(', 'users', 'post(', 'posts(',
      'pointBalance(', 'pointCharges(', 'pointSpends(',
      'signUp(', 'createPost(', 'publishPost(', 'changeUserStatus(',
      'chargePoint(', 'spendPoint(', 'transferPoint(',
    ]) {
      expect(sdl).toContain(field);
    }
  });
});
