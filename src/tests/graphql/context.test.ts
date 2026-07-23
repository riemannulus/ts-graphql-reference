import { describe, expect, it } from 'vitest';
import type { Context } from '../../graphql/context.js';
import { writer } from '../../graphql/context.js';

/**
 * The type-level half of the read/write split — that `ctx.db` (a
 * `ReadDbClient`) exposes no write methods — is proven at compile time and
 * cannot be asserted at runtime. What CAN escape the type system is
 * `writer(ctx)`, the one widening back to a full client; these tests pin its
 * runtime guard, so the escape hatch stays mutation-only.
 */
function fakeContext(operation: Context['operation']): Context {
  const db = { marker: 'routed-client' } as unknown as Context['db'];
  return {
    db,
    operation,
    services: {} as never,
    flags: {} as never,
    logger: {} as never,
    req: {} as never,
    reply: {} as never,
  };
}

describe('writer(ctx) — the guarded write path', () => {
  it('hands back the routed client during a mutation', () => {
    const ctx = fakeContext('mutation');
    expect(writer(ctx)).toBe(ctx.db);
  });

  it('throws for a query operation — a query resolver has no write path', () => {
    expect(() => writer(fakeContext('query'))).toThrow(/mutation-only/);
  });

  it('throws for an unclassified operation, defaulting closed', () => {
    expect(() => writer(fakeContext('other'))).toThrow(/mutation-only/);
  });
});
