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
  it('creates a user and post, then reads the relation', async () => {
    const created = await gql(
      'mutation ($e: String!) { createUser(input: { email: $e, name: "Alice" }) { id email } }',
      { e: 'a@b.com' },
    );
    expect(created.errors).toBeUndefined();
    const userId = Number(created.data?.createUser.id);

    const post = await gql(
      'mutation ($t: String!, $a: Int!) { createPost(input: { title: $t, authorId: $a }) { id } }',
      { t: 'Hello', a: userId },
    );
    expect(post.errors).toBeUndefined();

    const res = await gql('{ users { email posts { title } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data?.users).toHaveLength(1);
    expect(res.data?.users[0].posts[0].title).toBe('Hello');
  });

  it('surfaces an illegal status transition as a domain error', async () => {
    const created = await gql('mutation { createUser(input: { email: "x@y.com" }) { id } }');
    const id = Number(created.data?.createUser.id);

    await gql(`mutation { changeUserStatus(id: ${id}, status: DEACTIVATED) { status } }`);
    const res = await gql(`mutation { changeUserStatus(id: ${id}, status: ACTIVE) { status } }`);

    expect(res.data?.changeUserStatus).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
