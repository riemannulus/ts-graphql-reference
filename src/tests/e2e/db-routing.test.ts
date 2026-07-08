import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma } from '../support/helpers.js';

// Proves the rw/ro routing deterministically by giving the app two DIFFERENT
// databases: everything a mutation touches lands in rw, everything a query
// reads comes from ro. In production the two are the primary and its replica
// (eventually identical); here they never converge, which makes the routing
// direction of every operation observable.
const rw = await makeTestPrisma();
const ro = await makeTestPrisma();
const { app } = buildApp({ db: { rw, ro }, logger: false });

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

afterAll(async () => {
  await app.close();
  // Injected clients stay the injector's to manage.
  await rw.$disconnect();
  await ro.$disconnect();
});

describe('rw/ro selection-client routing', () => {
  it('mutations write to rw AND re-fetch their selection from rw (read-your-writes)', async () => {
    const res = await gql(
      'mutation { signUp(input: { email: "rw@example.com" }) { email posts { title } } }',
    );

    // The re-fetch (including the posts relation) succeeded even though the
    // replica has no such user — proof the mutation's selection ran on rw.
    expect(res.errors).toBeUndefined();
    expect(res.data?.signUp.email).toBe('rw@example.com');
    expect(res.data?.signUp.posts).toHaveLength(1);

    expect(await rw.user.count()).toBe(1);
    expect(await ro.user.count()).toBe(0);
  });

  it('queries read from ro', async () => {
    // Present only on the replica…
    await ro.user.create({ data: { email: 'ro-only@example.com' } });

    const res = await gql('query { users { email } }');
    const emails = res.data?.users.map((u: { email: string }) => u.email);

    // …and that is exactly what the query path sees: the ro-only user, not the
    // rw-only user written by the mutation above.
    expect(emails).toContain('ro-only@example.com');
    expect(emails).not.toContain('rw@example.com');
  });
});
