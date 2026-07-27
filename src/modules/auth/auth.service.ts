import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/db.js';
import { uow } from '../../db/uow.js';
import type { Clock } from '../../foundation/clock.js';
import { addDays } from '../../foundation/time.js';
import * as authRepo from './auth.repo.js';
import type { Credential, Principal } from './auth.value.js';

/**
 * Session use-cases — the principal seam's shell.
 *
 * Two operations, and they are the whole authentication story this reference
 * has: MINT one at the end of a successful OAuth login, and RESOLVE one on every
 * subsequent request. Deliberately separate from `oauth.service.ts`, which
 * sequences the provider calls: the OAuth flow is one way to obtain a session,
 * not the definition of one, and keeping them apart means the OAuth service's
 * unit test never has to learn about sessions.
 *
 * This is NOT an authorization layer. There are no roles or scopes, and
 * `resolvePrincipal` answers exactly one question — "which user is this?".
 * Deciding what that user may DO stays with each resolver until the first real
 * rule appears (the graduation rule, CONVENTIONS §1); the subscription surface
 * needs only identity, because its authorization is the re-fetch `where`.
 */

/**
 * Session lifetime. A single constant rather than a config knob: the reference
 * has one kind of session, and a knob nobody turns is a worse API than a number
 * with a comment.
 */
const SESSION_TTL_DAYS = 30;

/**
 * Token entropy. 32 random bytes, base64url — 256 bits, which is the point: the
 * token is a bearer credential with no signature and no structure, so guessing
 * resistance is the ONLY thing protecting a session. A UUID (122 bits, and v4 is
 * not required to come from a CSPRNG) is the wrong tool even though the repo uses
 * `randomUUID` elsewhere for non-secret ids.
 */
const TOKEN_BYTES = 32;

export interface SessionServiceDeps {
  db: Db;
  clock: Clock;
}

/** What a freshly minted session hands back to the transport that will store it. */
export interface MintedSession {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

export function createSessionService(deps: SessionServiceDeps) {
  return {
    /**
     * Issues a session for a user. `expiresAt` is stamped from the injected clock
     * ONCE, here in the use-case, and written by the repo as data — the column has
     * no `@default`, so the instant a decision later reads back is the instant a
     * decision chose (CONVENTIONS §10 rule 1).
     */
    async mint(userId: number): Promise<MintedSession> {
      const accessToken = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = addDays(deps.clock.now(), SESSION_TTL_DAYS);
      await uow.run(deps.db, (tx) => authRepo.createSession(tx, { accessToken, userId, expiresAt }));
      return { accessToken, expiresAt };
    },

    /**
     * Resolves a presented credential to a principal, or null.
     *
     * Returns null rather than throwing for BOTH "no such session" and "expired".
     * That is load-bearing: this runs inside the GraphQL context factory, which
     * Yoga awaits before parsing, so a throw here would fail the whole request —
     * including a perfectly legal anonymous query. Refusing an unauthenticated
     * caller is a decision for the field that needs a principal, which is what
     * `requirePrincipal(ctx)` does.
     *
     * Expiry is compared in CODE against the app clock, not as a `WHERE
     * expiresAt > now()` predicate. Both are single-clocked, but only this one can
     * be pinned by a fixed clock in a test (CONVENTIONS §10 "The two clocks"), and
     * the row is being read anyway so the predicate saves nothing.
     */
    async resolvePrincipal(credential: Credential): Promise<Principal | null> {
      // `db.rw`, not `ro`, even though this is a read on the hottest path there
      // is. A use-case decides on the state it will act against, and a session
      // minted a moment ago on the primary must resolve on the very next request
      // — a replica-lagged miss would log the user straight back out.
      const session = await authRepo.findByAccessToken(deps.db.rw, credential);
      if (session === null) return null;
      if (session.expiresAt.getTime() <= deps.clock.now().getTime()) return null;
      return { userId: session.userId, sessionId: session.id };
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
