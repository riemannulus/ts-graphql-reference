import { Buffer } from 'node:buffer';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../foundation/time.js';
import { createSessionService } from '../../../modules/auth/auth.service.js';
import {
  parseCredential,
  SESSION_COOKIE_NAME,
  type Credential,
  type CredentialSource,
} from '../../../modules/auth/auth.value.js';
import { fixedClock } from '../../support/clock.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

// The session use-cases against the real (PGlite) database — the principal seam
// end to end: mint writes a row, resolve reads one back and decides whether it
// still counts.
//
// The clock is FIXED at NOW, and NOW is deliberately NOT "around now": every
// instant this file asserts on is derived from that constant, so a stamp taken
// from the wall clock (or from the DATABASE's clock) can never coincidentally
// agree with one taken from the injected clock. That is the whole leverage of
// CONVENTIONS §10 rule 1, and it is why the expiry tests need no real waiting —
// crossing the boundary is a matter of building a SECOND service over the SAME
// database with a later fixed clock.
//
// PGlite is single-connection: `mint` opens an interactive transaction (uow.run),
// so every call here is fully awaited before the next statement is issued. No
// Promise.all over two mints, and no query smuggled in while a mint is in flight
// — either would deadlock the one connection rather than exercise concurrency.
const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };
const NOW = new Date('2026-03-01T12:00:00.000Z');

/**
 * The TTL, restated as a literal on purpose. `SESSION_TTL_DAYS` is private to the
 * service, and importing it would make this test agree with the implementation by
 * construction — "30 days" is the law, so the test spells the number out and a
 * change to the constant has to be a deliberate change here too.
 */
const TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 32 random bytes rendered base64url: 43 characters from the URL-safe alphabet,
 * no `=` padding. Pinning the SHAPE is what turns "someone simplified the
 * generator" (a uuid, a counter, a slice of the user id) into a failure rather
 * than a silent loss of ~130 bits of guessing resistance.
 */
const BASE64URL_256_BIT = /^[A-Za-z0-9_-]{43}$/;

const sessions = createSessionService({ db, clock: fixedClock(NOW) });

/** The same use-cases over the same rows, but with the world's clock moved. */
function sessionsAt(instant: Date) {
  return createSessionService({ db, clock: fixedClock(instant) });
}

beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await prisma.$disconnect();
});

let userSeq = 0;
async function makeUser(): Promise<number> {
  const user = await prisma.user.create({ data: { email: `session-${userSeq++}@example.com` } });
  return user.id;
}

/**
 * A `Credential` obtained the way a request produces one — through the parser,
 * never through a cast. The brand means "this crossed the boundary", so faking it
 * with `as Credential` would test the service against a value the transport can
 * never hand it; going through `parseCredential` keeps the two halves of the seam
 * honest and costs one line.
 */
function credentialFrom(source: CredentialSource): Credential {
  const credential = parseCredential(source);
  if (credential === null) {
    throw new Error(`parseCredential found no credential in ${JSON.stringify(source)}`);
  }
  return credential;
}

const presented = (token: string): Credential =>
  credentialFrom({ authorization: `Bearer ${token}` });

describe('SessionService.mint → resolvePrincipal (the round trip)', () => {
  it('resolves a freshly minted token to the minting user and the stored row id', async () => {
    const userId = await makeUser();
    const { accessToken } = await sessions.mint(userId);

    const row = await prisma.session.findUniqueOrThrow({ where: { accessToken } });
    const principal = await sessions.resolvePrincipal(presented(accessToken));

    // Exact equality, not a subset match: `Principal` is deliberately TINY, and a
    // resolver that started leaking an email or a role onto every request should
    // fail here rather than quietly grow the value copied onto every socket.
    expect(principal).toEqual({ userId, sessionId: row.id });
  });

  it('resolves to the same principal whichever channel presented the token', async () => {
    const userId = await makeUser();
    const { accessToken } = await sessions.mint(userId);

    const viaCookie = credentialFrom({
      cookieHeader: `${SESSION_COOKIE_NAME}=${encodeURIComponent(accessToken)}`,
    });
    const viaParams = credentialFrom({ connectionParams: { accessToken } });

    // Identity is a property of the TOKEN, not of the transport that carried it —
    // the HTTP context factory and the graphql-ws hook must agree, or a
    // subscription would authenticate as somebody the query path would not.
    const expected = await sessions.resolvePrincipal(presented(accessToken));
    expect(expected).not.toBeNull();
    expect(await sessions.resolvePrincipal(viaCookie)).toEqual(expected);
    expect(await sessions.resolvePrincipal(viaParams)).toEqual(expected);
  });
});

describe('SessionService.mint (the expiry stamp)', () => {
  it('stamps expiresAt from the INJECTED clock, exactly TTL days out', async () => {
    const userId = await makeUser();
    const minted = await sessions.mint(userId);

    // CONVENTIONS §10 rule 1: a decision-relevant timestamp is stamped once, by
    // the use-case, from the clock it was handed. NOW is months away from the
    // wall clock, so `new Date()` in the service — or an `@default(now())` on the
    // column, which stamps from the DATABASE's clock — fails this line by
    // whatever the real elapsed time happens to be.
    const expected = addDays(NOW, TTL_DAYS);
    expect(minted.expiresAt.toISOString()).toBe(expected.toISOString());

    const row = await prisma.session.findUniqueOrThrow({
      where: { accessToken: minted.accessToken },
    });
    // The instant a decision later READS BACK is the instant the decision chose:
    // the value must survive the round trip through Timestamptz, because
    // `resolvePrincipal` compares this column, and the OAuth route mirrors it
    // into the cookie's `Expires`.
    expect(row.expiresAt.toISOString()).toBe(expected.toISOString());
    expect(row.expiresAt.getTime()).toBe(minted.expiresAt.getTime());

    // …and "30 days" is 30 exact days, spelled out independently of `addDays`.
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(TTL_DAYS * DAY_MS);
  });

  it('gives every session the same TTL measured from ITS OWN mint instant', async () => {
    const userId = await makeUser();
    const early = await sessions.mint(userId);
    const late = await sessionsAt(addDays(NOW, 7)).mint(userId);

    // The TTL is a duration from minting, not a fixed calendar date shared by
    // every session — a "session horizon" constant would pass the test above and
    // fail this one.
    expect(late.expiresAt.getTime() - early.expiresAt.getTime()).toBe(7 * DAY_MS);
  });
});

describe('SessionService.resolvePrincipal (the expiry decision)', () => {
  it('refuses a session once its expiry has passed', async () => {
    const userId = await makeUser();
    const { accessToken, expiresAt } = await sessions.mint(userId);
    const credential = presented(accessToken);

    expect(await sessions.resolvePrincipal(credential)).not.toBeNull();

    // Crossing the boundary WITHOUT waiting: a second service over the same rows,
    // holding a clock a day past the expiry. This is the deterministic form of
    // "time passed" — no timers, no sleeps, and nothing that changes meaning when
    // the suite runs on a slow machine.
    const tomorrow = sessionsAt(addDays(expiresAt, 1));
    expect(await tomorrow.resolvePrincipal(credential)).toBeNull();

    // Expiry is a READ-TIME decision, not a delete. Reaping rows belongs to
    // `deleteExpired`, and resolving must never mutate on the hottest path.
    expect(await prisma.session.count({ where: { accessToken } })).toBe(1);
  });

  it('treats the expiry INSTANT itself as already expired', async () => {
    const userId = await makeUser();
    const { accessToken, expiresAt } = await sessions.mint(userId);
    const credential = presented(accessToken);

    // One millisecond before the stamp → still live.
    const justBefore = sessionsAt(new Date(expiresAt.getTime() - 1));
    expect(await justBefore.resolvePrincipal(credential)).not.toBeNull();

    // Exactly AT the stamp → dead. The service compares `expiresAt <= now`, so
    // the boundary is EXCLUSIVE: `expiresAt` is the first instant at which the
    // session no longer resolves, not the last at which it does. Pinned
    // explicitly because it is a one-character change (`<=` → `<`) that no other
    // test in the suite would notice, and because the cookie's `Expires`
    // attribute is the same instant — the browser and the server must agree on
    // which side of it the session is dead.
    const exactly = sessionsAt(new Date(expiresAt.getTime()));
    expect(await exactly.resolvePrincipal(credential)).toBeNull();
  });

  it('never resurrects: a clock rolled back past the mint still resolves', async () => {
    const userId = await makeUser();
    const { accessToken } = await sessions.mint(userId);

    // Only the upper bound is a decision here — there is no "not before" check,
    // and inventing one would break the OAuth redirect on a host with skewed
    // time. Stated so a future `now < createdAt` guard is a deliberate change.
    const earlier = sessionsAt(addDays(NOW, -1));
    expect(await earlier.resolvePrincipal(presented(accessToken))).not.toBeNull();
  });
});

describe('SessionService.resolvePrincipal (the anonymous cases)', () => {
  it('returns null, and does not throw, for a token no session backs', async () => {
    // Load-bearing: this runs inside the GraphQL context factory, which Yoga
    // awaits BEFORE parsing. A throw here fails the whole request — including a
    // perfectly legal anonymous query — so an unknown token must be an answer,
    // never an error.
    await expect(sessions.resolvePrincipal(presented('nobody-minted-this'))).resolves.toBeNull();
  });

  it('returns null once the session row is gone (logout, or the purge job)', async () => {
    const userId = await makeUser();
    const { accessToken } = await sessions.mint(userId);
    const credential = presented(accessToken);
    expect(await sessions.resolvePrincipal(credential)).not.toBeNull();

    await prisma.session.delete({ where: { accessToken } });
    expect(await sessions.resolvePrincipal(credential)).toBeNull();
  });

  it('returns null for a token that differs from a live one by a single character', async () => {
    const userId = await makeUser();
    const { accessToken } = await sessions.mint(userId);

    // The lookup is an exact unique match — no prefix, no `LIKE`, no
    // case-insensitive collation. A token is opaque bytes, and `parseCredential`
    // trims but deliberately does not lowercase.
    const tweaked = `${accessToken.slice(0, -1)}${accessToken.endsWith('A') ? 'B' : 'A'}`;
    expect(await sessions.resolvePrincipal(presented(tweaked))).toBeNull();
  });
});

describe('SessionService.mint (token generation)', () => {
  it('mints a distinct 256-bit token per call, and both sessions stay live', async () => {
    const userId = await makeUser();
    // Sequential, not Promise.all — see the single-connection note at the top.
    const first = await sessions.mint(userId);
    const second = await sessions.mint(userId);

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(await prisma.session.count({ where: { userId } })).toBe(2);

    for (const { accessToken } of [first, second]) {
      expect(accessToken).toMatch(BASE64URL_256_BIT);
      // 43 base64url characters decode to exactly 32 bytes. A uuid (36 chars,
      // 122 bits, and v4 need not come from a CSPRNG) fails both assertions —
      // which is the point, since the token carries no signature and guessing
      // resistance is the only thing protecting the session.
      expect(Buffer.from(accessToken, 'base64url')).toHaveLength(32);
    }

    // Minting a second session does not invalidate the first: logging in on a
    // phone must not sign the laptop out.
    const one = await sessions.resolvePrincipal(presented(first.accessToken));
    const two = await sessions.resolvePrincipal(presented(second.accessToken));
    expect(one?.userId).toBe(userId);
    expect(two?.userId).toBe(userId);
    expect(one?.sessionId).not.toBe(two?.sessionId);
  });

  it('does not derive the token from the user id', async () => {
    // A DISTINCTIVE id, so "the token contains it" is a signal rather than a
    // coincidence: a random 43-char base64url string contains a given 7-digit run
    // with probability ~1e-11, which is the difference between a regression guard
    // and a flake. The cheap thing someone reaches for when "simplifying" the
    // generator is a value keyed off the user — `${userId}-${something}`, a hash
    // of the id, the id base64'd — and every one of those trips a check below.
    const distinctiveId = 9_150_237;
    const user = await prisma.user.create({
      data: { id: distinctiveId, email: 'derived@example.com' },
    });
    const { accessToken } = await sessions.mint(user.id);

    expect(accessToken).not.toContain(String(distinctiveId));
    expect(accessToken).not.toContain(Buffer.from(String(distinctiveId)).toString('base64url'));
    expect(accessToken).not.toContain(distinctiveId.toString(16));
    expect(accessToken).toMatch(BASE64URL_256_BIT);

    // …and it still has to work.
    expect(await sessions.resolvePrincipal(presented(accessToken))).toEqual({
      userId: distinctiveId,
      sessionId: expect.any(String),
    });
  });
});
