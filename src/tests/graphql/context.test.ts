import { describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '../../foundation/errors.js';
import type { Context } from '../../graphql/context.js';
import { requirePrincipal, writer } from '../../graphql/context.js';

/**
 * The type-level halves of two splits — that `ctx.db` (a `ReadDbClient`) exposes
 * no write methods, and that `ctx.events` exposes no `publish` — are proven at
 * compile time and cannot be asserted at runtime. What CAN escape the type
 * system are the two guarded widenings, `writer(ctx)` and `requirePrincipal(ctx)`;
 * these tests pin their runtime guards.
 */
function fakeContext(
  operation: Context['operation'],
  principal?: Context['principal'],
): Context {
  const db = { marker: 'routed-client' } as unknown as Context['db'];
  return {
    db,
    operation,
    services: {} as never,
    events: {} as never,
    flags: {} as never,
    logger: {} as never,
    req: {} as never,
    reply: {} as never,
    ...(principal === undefined ? {} : { principal }),
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

  it('throws for a subscription — a stream re-fetch is a read', () => {
    expect(() => writer(fakeContext('subscription'))).toThrow(/mutation-only/);
  });
});

describe('requirePrincipal(ctx) — the guarded identity path', () => {
  it('hands back the principal when the request resolved one', () => {
    const principal = { userId: 7, sessionId: 'sess-1' };
    expect(requirePrincipal(fakeContext('query', principal))).toBe(principal);
  });

  it('throws UNAUTHENTICATED for an anonymous request', () => {
    // A DomainError, not a plain Error: being logged out is an ordinary
    // client-visible outcome, unlike calling writer() from a query.
    expect(() => requirePrincipal(fakeContext('query'))).toThrow(UnauthenticatedError);
    expect(() => requirePrincipal(fakeContext('query'))).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }) as unknown as Error,
    );
  });

  it('never leaks a credential into the error message', () => {
    // The message reaches the client AND, pre-mask, the OTel span.
    try {
      requirePrincipal(fakeContext('subscription'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toMatch(/token|cookie|sid=/i);
    }
  });
});
