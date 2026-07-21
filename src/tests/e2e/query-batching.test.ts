import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Pins the no-N+1 law the schema layer relies on (CONVENTIONS.md "Per-parent
// reads and aggregates"): relations (`t.relation`) and aggregate counts
// (`t.relationCount`) ride the PARENT's Prisma query as `include` / `_count`
// sub-selects, so resolving a list never issues per-row queries. The SDL
// snapshot guards what the schema says; this file guards how it reads —
// a refactor that silently drops the `query` spread (turning one merged query
// into N+1) fails here, not in production.
const queries: string[] = [];
const prisma = await makeTestPrisma({ onQuery: (sql) => queries.push(sql) });
const { app } = buildApp({ prisma, logger: false });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string }>;
}

async function gql(query: string): Promise<GqlResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  return res.json() as GqlResult;
}

/** One user with one draft and `i + 1` published posts. */
async function seedAuthor(i: number): Promise<void> {
  const user = await prisma.user.create({ data: { email: `author${i}@q.com` } });
  await prisma.post.createMany({
    data: [
      { title: `draft ${i}`, authorId: user.id },
      ...Array.from({ length: i + 1 }, (_, j) => ({
        title: `published ${i}.${j}`,
        published: true,
        authorId: user.id,
      })),
    ],
  });
}

async function seed(authors: number): Promise<void> {
  await Promise.all(Array.from({ length: authors }, (_, i) => seedAuthor(i)));
}

// Traverses list → relation → aggregate: every rung that must stay batched.
const NESTED_LIST = '{ posts { title author { email postCount publishedPostCount } } }';

/** SELECT statements issued while resolving NESTED_LIST over `authors` users. */
async function selectsFor(authors: number): Promise<number> {
  await resetDb(prisma);
  await seed(authors);
  queries.length = 0;
  const res = await gql(NESTED_LIST);
  expect(res.errors).toBeUndefined();
  return queries.filter((sql) => /^\s*SELECT/i.test(sql)).length;
}

afterAll(async () => {
  await app.close();
  await prisma.$disconnect(); // injected clients stay the injector's to manage
});

describe('query batching (no N+1)', () => {
  it('resolves relation counts through the parent query', async () => {
    await resetDb(prisma);
    await seed(2);
    const res = await gql('{ users { email postCount publishedPostCount } }');
    expect(res.errors).toBeUndefined();
    // `users` has no orderBy, so compare order-insensitively.
    const users = [...(res.data?.users ?? [])].toSorted((a, b) =>
      a.email.localeCompare(b.email),
    );
    expect(users).toEqual([
      { email: 'author0@q.com', postCount: 2, publishedPostCount: 1 },
      { email: 'author1@q.com', postCount: 3, publishedPostCount: 2 },
    ]);
  });

  it('issues a flat number of queries regardless of row count', async () => {
    // The law is O(1) in rows, not an exact plan: Prisma may split a nested
    // include into one query per LEVEL (its `query` relation-load strategy),
    // which is fine — what must never happen is a query per ROW.
    const forOne = await selectsFor(1);
    const forMany = await selectsFor(7);
    expect(forMany).toBe(forOne);
    expect(forOne).toBeLessThanOrEqual(4);
  });
});
