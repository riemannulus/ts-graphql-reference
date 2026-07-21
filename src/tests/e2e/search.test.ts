import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { PostSearchIndex } from '../../modules/search/post-search.provider.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

/**
 * A fake index injected via buildApp: it does no real matching, it just returns
 * canned ids in a chosen rank order, which is enough to prove the wiring — the
 * `hits` prismaField receives the nested selection, and findByIds hydrates in
 * that order (including relations). `ranked` is reset per test.
 */
let ranked: number[] = [];
let reportedTotal = 0;
const fakeIndex: PostSearchIndex = {
  search: (_term, { limit }) => Promise.resolve({ total: reportedTotal, ids: ranked.slice(0, limit) }),
};

const prisma = await makeTestPrisma();
const { app } = buildApp({ prisma, logger: false, postSearchIndex: fakeIndex });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: Record<string, any> }>;
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

/** Create a user + N posts; returns the ordered post ids. */
async function seed(): Promise<number[]> {
  const signUp = await gql('mutation { signUp(input: { email: "author@t.com" }) { id } }');
  const authorId = Number(signUp.data?.signUp.id);
  const ids: number[] = [];
  for (const title of ['Alpha', 'Bravo', 'Charlie']) {
    // eslint-disable-next-line no-await-in-loop -- sequential seeding, ids read from each response
    const res = await gql(
      `mutation { createPost(input: { title: "${title}", authorId: ${authorId} }) { id } }`,
    );
    ids.push(Number(res.data?.createPost.id));
  }
  return ids;
}

beforeEach(async () => {
  await resetDb(prisma);
  ranked = [];
  reportedTotal = 0;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('searchPosts (external-key hydration via the hits prismaField)', () => {
  it('returns hits in the index rank order with the reported total', async () => {
    const [alpha, bravo, charlie] = await seed();
    ranked = [charlie!, alpha!, bravo!]; // index ranking, not DB order
    reportedTotal = 42;

    const res = await gql(
      'query { searchPosts(term: "anything") { total hits { id title } } }',
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.searchPosts.total).toBe(42);
    expect(res.data?.searchPosts.hits.map((h: { title: string }) => h.title)).toEqual([
      'Charlie',
      'Alpha',
      'Bravo',
    ]);
  });

  it('loads a nested relation under hits — the selection reaches the field query', async () => {
    const [alpha] = await seed();
    ranked = [alpha!];
    reportedTotal = 1;

    // The `author` relation under `hits` must ride the query Pothos hands the field.
    const res = await gql(
      'query { searchPosts(term: "x") { hits { title author { email } } } }',
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.searchPosts.hits[0]).toMatchObject({
      title: 'Alpha',
      author: { email: 'author@t.com' },
    });
  });

  it('respects the limit argument', async () => {
    const [alpha, bravo, charlie] = await seed();
    ranked = [charlie!, alpha!, bravo!];
    reportedTotal = 3;

    const res = await gql('query { searchPosts(term: "x", limit: 2) { hits { id } } }');
    expect(res.data?.searchPosts.hits.map((h: { id: string }) => Number(h.id))).toEqual([
      charlie,
      alpha,
    ]);
  });
});
