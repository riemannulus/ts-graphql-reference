import type { Session } from '@prisma/client';
import type { DbClient, ReadDbClient } from '../../db/db.js';

/**
 * Session persistence for the principal seam.
 *
 * Sessions never reach GraphQL — no resolver selects one, so no function here
 * takes a Pothos `Selection`. They are looked up by token on the request path and
 * written once at login, which is the whole surface.
 *
 * Note what these signatures do NOT say: nothing here decides whether a session
 * is still valid. The row carries `expiresAt`; comparing it to "now" is a
 * decision, and decisions are the service's (CONVENTIONS §10 "The two clocks" —
 * the comparison runs against the injected app clock so a fixed test clock can
 * pin it, rather than against the DB clock inside a `WHERE`).
 */

export interface CreateSessionInput {
  /**
   * The opaque token. A plain `string`, not the branded `Credential`: the brand
   * marks "parsed from an untrusted request" (see `auth.value.ts`), which is
   * provenance, not a storage invariant — and this value is one WE generated, so
   * it never crossed that boundary. Branding it here would say something false.
   */
  accessToken: string;
  userId: number;
  /** Stamped by the minting use-case from the injected clock; never a DB default. */
  expiresAt: Date;
}

/**
 * The session for a presented token, or null. Unique by `Session_accessToken_key`,
 * so this is single-valued by construction.
 */
export function findByAccessToken(db: ReadDbClient, accessToken: string): Promise<Session | null> {
  return db.session.findUnique({ where: { accessToken } });
}

export function createSession(db: DbClient, input: CreateSessionInput): Promise<Session> {
  return db.session.create({
    data: {
      accessToken: input.accessToken,
      expiresAt: input.expiresAt,
      user: { connect: { id: input.userId } },
    },
  });
}

/**
 * Removes sessions that expired before `now` — the instant is passed IN, the repo
 * does not read a clock. Not wired to a job in the reference (there is no
 * authenticated traffic to generate a backlog yet); it exists so the retention
 * story is complete and a `auth:session:purge` job is a two-line addition.
 */
export async function deleteExpired(db: DbClient, now: Date): Promise<number> {
  // `lte`, matching `resolvePrincipal`'s `expiresAt <= now`. With `lt` the two
  // rules disagree on the boundary instant: the session would already resolve to
  // nobody while the sweep still considered it live. Harmless in practice, but a
  // reaper and a validator that draw the line in different places is the kind of
  // drift that becomes a real bug the first time someone reuses one of them.
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
