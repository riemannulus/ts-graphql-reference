import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  parseCookieHeader,
  parseCredential,
  SESSION_COOKIE_NAME,
  type CredentialSource,
} from '../../../modules/auth/auth.value.js';

// An opaque session token from the base64url/uuid alphabet: safe to embed RAW in
// a cookie value, in a `Bearer` header, and in JSON, so a failing case shrinks to
// something readable instead of to an escaping accident.
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'.split('');
const arbToken = fc
  .array(fc.constantFrom(...TOKEN_ALPHABET), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''));

// Everything that is "present but not a credential": the empty string plus the
// whitespace forms a sloppy client or a logout that cleared the value can leave.
const arbBlank = fc.constantFrom('', ' ', '   ', '\t', '\n', ' \t \n ');

// `connectionParams` is `unknown` on the wire, so the generator must cover the
// shapes a bare `typeof x === 'object'` would wave through — null, arrays,
// scalars, a null-prototype object, a non-string `accessToken`, and a payload
// that hides the token behind `__proto__`.
const arbConnectionParams = fc.oneof(
  fc.anything(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.anything(), { maxLength: 4 }),
  fc.integer(),
  fc.string(),
  fc.constant(Object.create(null) as unknown),
  fc.constant(JSON.parse('{"__proto__":{"accessToken":"polluted"}}') as unknown),
  fc.record({
    accessToken: fc.oneof(
      fc.string(),
      arbToken,
      arbBlank,
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.record({ nested: fc.string() }),
    ),
  }),
);

const arbSource: fc.Arbitrary<CredentialSource> = fc.record(
  {
    cookieHeader: fc.oneof(fc.string(), fc.constant(undefined)),
    authorization: fc.oneof(fc.string(), fc.constant(undefined)),
    connectionParams: arbConnectionParams,
  },
  { requiredKeys: [] },
);

// A `Cookie` header as browsers and attackers both write it: well-formed pairs
// mixed with attribute crumbs that carry no `=`.
const arbCookieHeader = fc.oneof(
  fc.string(),
  fc
    .array(
      fc.oneof(
        fc.string(),
        fc.tuple(fc.string(), fc.string()).map(([name, value]) => `${name}=${value}`),
      ),
      { maxLength: 6 },
    )
    .map((fragments) => fragments.join('; ')),
);

const cookie = (value: string): string => `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`;

describe('parseCredential invariants', () => {
  // LAW 1 — totality. The whole point of the seam: an untrusted request cannot
  // make the parser throw, so no hostile header turns into a masked 500.
  test.prop([arbSource])('is total: returns a trimmed non-empty string or null', (source) => {
    const credential = parseCredential(source);
    if (credential !== null) {
      expect(typeof credential).toBe('string');
      expect(credential.length).toBeGreaterThan(0);
      expect(credential.trim()).toBe(credential);
    }
  });

  // LAW 2 — precedence. Cookie beats header beats connectionParams, and the
  // ranking must hold for EVERY pair of distinct tokens, not one worked example.
  test.prop([arbToken, arbToken, arbToken])(
    'precedence: the sid cookie wins over Bearer, which wins over connectionParams',
    (a, b, c) => {
      // Prefixes make the three tokens distinct by construction — no filtering.
      const cookieToken = `c-${a}`;
      const bearerToken = `b-${b}`;
      const paramToken = `p-${c}`;
      const cookieHeader = cookie(cookieToken);
      const authorization = `Bearer ${bearerToken}`;
      const connectionParams = { accessToken: paramToken };

      expect(parseCredential({ cookieHeader, authorization, connectionParams })).toBe(cookieToken);
      expect(parseCredential({ authorization, connectionParams })).toBe(bearerToken);
      expect(parseCredential({ connectionParams })).toBe(paramToken);
    },
  );

  test.prop([fc.constantFrom('Bearer', 'bearer', 'BEARER', 'BeArEr'), arbToken])(
    'the Bearer scheme is matched case-insensitively',
    (scheme, token) => {
      expect(parseCredential({ authorization: `${scheme} ${token}` })).toBe(token);
    },
  );

  // LAW 3 — absence. A present-but-blank higher-precedence source must FALL
  // THROUGH; a stale `sid=` cookie left by a logout cannot mask a good header.
  test.prop([arbBlank, arbToken])(
    'a blank sid cookie falls through to the Authorization header',
    (blank, token) => {
      expect(parseCredential({ cookieHeader: cookie(blank), authorization: `Bearer ${token}` })).toBe(
        token,
      );
    },
  );

  test.prop([arbBlank, arbBlank, arbToken])(
    'a blank cookie and a blank Bearer fall through to connectionParams',
    (cookieBlank, bearerBlank, token) => {
      expect(
        parseCredential({
          cookieHeader: cookie(cookieBlank),
          authorization: `Bearer ${bearerBlank}`,
          connectionParams: { accessToken: token },
        }),
      ).toBe(token);
    },
  );

  test.prop([arbBlank, arbBlank, arbBlank])(
    'a source with nothing usable anywhere is anonymous (null)',
    (cookieBlank, bearerBlank, paramBlank) => {
      expect(
        parseCredential({
          cookieHeader: cookie(cookieBlank),
          authorization: `Bearer ${bearerBlank}`,
          connectionParams: { accessToken: paramBlank },
        }),
      ).toBeNull();
    },
  );

  test.prop([arbToken])('only the EXACT sid cookie name counts', (token) => {
    const decoys = `x${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}x=${token}`;
    expect(parseCredential({ cookieHeader: decoys })).toBeNull();
  });
});

describe('parseCredential — the hostile connectionParams narrowing', () => {
  it('treats an empty source as anonymous', () => {
    expect(parseCredential({})).toBeNull();
  });

  it('ignores non-object, null, and array connectionParams', () => {
    expect(parseCredential({ connectionParams: null })).toBeNull();
    expect(parseCredential({ connectionParams: 42 })).toBeNull();
    expect(parseCredential({ connectionParams: 'accessToken' })).toBeNull();
    expect(parseCredential({ connectionParams: ['token'] })).toBeNull();
  });

  it('ignores a non-string accessToken', () => {
    expect(parseCredential({ connectionParams: { accessToken: 42 } })).toBeNull();
    expect(parseCredential({ connectionParams: { accessToken: { token: 'x' } } })).toBeNull();
  });

  // A token reachable only through the prototype was never "sent" by the client;
  // accepting it is how prototype pollution becomes an auth bypass.
  it('ignores an accessToken inherited through a __proto__ payload', () => {
    const polluted: unknown = JSON.parse('{"__proto__":{"accessToken":"polluted"}}');
    expect(parseCredential({ connectionParams: polluted })).toBeNull();
  });

  it('rejects an Authorization header that is not exactly two parts', () => {
    expect(parseCredential({ authorization: 'token-only' })).toBeNull();
    expect(parseCredential({ authorization: 'Bearer  double-space' })).toBeNull();
    expect(parseCredential({ authorization: 'Basic dXNlcjpwdw==' })).toBeNull();
  });
});

describe('parseCookieHeader invariants', () => {
  // LAW 4 — round-trip. `encodeURIComponent` is what the OAuth route writes, so
  // this pins the write side against the read side for ARBITRARY token bytes
  // (spaces, `;`, `=`, `%` — every character that would otherwise break the split).
  test.prop([fc.string()])('round-trips any encoded value under the sid name', (token) => {
    expect(parseCookieHeader(cookie(token))[SESSION_COOKIE_NAME]).toBe(token);
  });

  // LAW 5 — totality. A malformed header means "no cookies", never a throw.
  test.prop([arbCookieHeader])('is total over arbitrary strings', (header) => {
    const jar = parseCookieHeader(header);
    for (const [name, value] of Object.entries(jar)) {
      expect(typeof name).toBe('string');
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
      expect(typeof value).toBe('string');
    }
  });

  test.prop([arbToken, arbToken])('keeps the FIRST occurrence of a duplicated name', (a, b) => {
    const first = `f-${a}`;
    const second = `s-${b}`;
    const header = `${SESSION_COOKIE_NAME}=${first}; ${SESSION_COOKIE_NAME}=${second}`;
    expect(parseCookieHeader(header)[SESSION_COOKIE_NAME]).toBe(first);
  });
});

describe('parseCookieHeader — the documented parsing rules', () => {
  it('splits each pair at the FIRST = so base64 padding survives', () => {
    expect(parseCookieHeader('sid=YWJjZA==')['sid']).toBe('YWJjZA==');
  });

  it('skips fragments with no = and fragments with an empty name', () => {
    expect(parseCookieHeader('Secure; sid=abc; =orphan')).toEqual({ sid: 'abc' });
  });

  it('tolerates missing spaces and stray whitespace around names and values', () => {
    expect(parseCookieHeader('  a=1;b=2 ;  c = 3  ')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('falls back to the raw value when the percent-escape is invalid', () => {
    expect(parseCookieHeader('sid=%zz')['sid']).toBe('%zz');
    expect(parseCookieHeader('sid=100%')['sid']).toBe('100%');
  });

  it('returns an empty jar for an empty or attribute-only header', () => {
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('HttpOnly; Secure')).toEqual({});
  });

  it('materializes a hostile __proto__ pair as an OWN property', () => {
    const jar = parseCookieHeader('__proto__=polluted; sid=abc');
    expect(Object.hasOwn(jar, '__proto__')).toBe(true);
    expect(jar['sid']).toBe('abc');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
