import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Inject a test-DB-backed client; buildApp wires it through the GraphQL context.
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
afterAll(() => app.close()); // onClose hook disconnects prisma

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

  it('no longer exposes createUser', async () => {
    const res = await gql('mutation { createUser(input: { email: "z@z.com" }) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/createUser/);
  });

  it('surfaces an illegal status transition as a domain error', async () => {
    const created = await gql('mutation { signUp(input: { email: "x@y.com" }) { id } }');
    const id = Number(created.data?.signUp.id);

    await gql(`mutation { changeUserStatus(id: ${id}, status: DEACTIVATED) { status } }`);
    const res = await gql(`mutation { changeUserStatus(id: ${id}, status: ACTIVE) { status } }`);

    expect(res.data?.changeUserStatus).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
