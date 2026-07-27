/**
 * Credential value object (parse, don't validate) — the ONE place that answers
 * "which opaque token, if any, did this request present?", for HTTP and for
 * WebSocket alike.
 *
 * `Credential` is a branded string built to the `user.value.ts` recipe (the
 * `Email` analogue, CONVENTIONS §4): once a value carries the brand, the
 * invariant "a trimmed, non-empty token that a client actually sent" holds by
 * construction, and `parseCredential` is the ONLY way to mint one. What the
 * token MEANS — whether a live `Session` row backs it, whether it has expired —
 * is deliberately NOT decidable here; that is `auth.service.resolvePrincipal`,
 * which reads the database and takes `now` from the injected clock
 * (CONVENTIONS §10). This file owns the lexical half of the question only.
 *
 * It is a pure module and so it imports NOTHING — not even `errors.ts`, the one
 * dependency of its `oauth.value.ts` neighbour. That is also why
 * `CredentialSource` is a framework-free STRUCTURAL shape that never names
 * `FastifyRequest`: value files are lint-fenced off fastify / graphql / prisma
 * (CONVENTIONS §1), so the shell holding the real request pays a two-line cost
 * to project it — the same move a repo makes when it maps a Prisma row onto a
 * core's narrow input type (CONVENTIONS §4). The payoff is that the HTTP
 * context factory and the graphql-ws `onSubscribe` hook run the SAME parser,
 * collapsing crepe's per-transport if/else chain into one total function a
 * property test can hammer (CONVENTIONS §3, §6).
 *
 * DELIBERATE DIVERGENCE FROM `parseEmail` — that function THROWS on invalid
 * input, because a malformed address is a client mistake worth naming. This one
 * returns `Credential | null`, because ABSENCE IS NOT AN ERROR: an anonymous
 * request is the ordinary case for a public query, and only the field that
 * actually needs an identity may reject it (`requirePrincipal(ctx)`, the
 * `writer(ctx)` analogue in `graphql/context.ts`). Hence no error class lives in
 * this file, and every export below is total.
 *
 * How to extend: a new arrival channel is one optional field on
 * `CredentialSource`, one reader in `READ_CHANNEL`, and one name appended to
 * `CREDENTIAL_PRECEDENCE` — the exhaustive `Record` turns a forgotten reader
 * into a compile error, the same trick the flags registry's variant `Record`
 * plays (CONVENTIONS §9). What does NOT change: the brand, the
 * `Credential | null` return, totality over every input including hostile ones,
 * and the ordering rule that the cookie always wins.
 */

declare const credentialBrand: unique symbol;

/**
 * An opaque session token a client presented — trimmed, non-empty, and
 * otherwise UNINTERPRETED. The brand carries no claim that the token is valid,
 * unexpired, or even known to us; it carries only "something was presented, and
 * it survived the boundary's normalization". Resolving it to a principal is the
 * service's job, exactly as an `Email` says nothing about whether that user
 * exists.
 */
export type Credential = string & { readonly [credentialBrand]: 'Credential' };

/**
 * WHO a request is, once a credential has actually been resolved against a live
 * session — the other side of `Credential`. A `Credential` is "something was
 * presented"; a `Principal` is "and it was real, and unexpired, at the instant we
 * looked". Only `auth.service.resolvePrincipal` can produce one.
 *
 * Deliberately TINY. It carries the two ids a resolver may need to scope a query
 * (`userId`) or an audit line (`sessionId`) and nothing else — no roles, no
 * scopes, no email. Anything richer is a read, and a read belongs in a resolver
 * against `ctx.db`, not in a value that gets copied onto every request and, for a
 * subscription, held for the life of the socket where it would go stale.
 */
export interface Principal {
  readonly userId: number;
  readonly sessionId: string;
}

/**
 * Untrusted, framework-free view of where a credential can arrive from — the
 * `OAuthCallbackQuery` analogue in `oauth.value.ts`: a shape whose every field
 * is optional and unvalidated, so the parser below is the boundary that makes
 * it safe. Kept STRUCTURAL on purpose (see the module block): a Fastify request
 * satisfies it after two property reads, a graphql-ws connection after three,
 * and neither transport type leaks into a pure file.
 */
export interface CredentialSource {
  /** Raw `Cookie` request header, verbatim. */
  readonly cookieHeader?: string | undefined;
  /** Raw `Authorization` request header, verbatim. */
  readonly authorization?: string | undefined;
  /** graphql-ws `connectionParams` — arbitrary client-supplied JSON. */
  readonly connectionParams?: unknown;
}

/**
 * The cookie name the session credential travels in. Short and meaningless on
 * purpose: a cookie name is sent on every request and leaks nothing about the
 * stack. It lives here, beside the parser, so the OAuth route that SETS the
 * cookie and the context factory that READS it cannot drift apart.
 */
export const SESSION_COOKIE_NAME = 'sid';

/**
 * The arrival channels in PRECEDENCE ORDER — the ordering rule as data, in the
 * spirit of `lock-registry.ts`'s append-only namespace list, so "which source
 * wins" is one readable line rather than the shape of an if/else chain.
 *
 *  1. `cookie` — the `sid` cookie. FIRST because an `HttpOnly` cookie is the
 *     only channel script on the page cannot read back.
 *  2. `bearer` — `Authorization: Bearer <token>`, for non-browser clients that
 *     have no cookie jar.
 *  3. `connectionParams` — the graphql-ws LEGACY path. LAST, and deprecated:
 *     crepe's own comment on it says putting the token there "leaks access
 *     token to the client which can lead to XSS attack" (it must live in JS to
 *     be sent), and a WS upgrade is an ordinary HTTP request that carries
 *     cookies anyway — so channel 1 already covers every browser client.
 *
 * Append new channels at the END; reordering is a security change, not a
 * refactor, because it decides which of two presented tokens is believed.
 */
export const CREDENTIAL_PRECEDENCE = ['cookie', 'bearer', 'connectionParams'] as const;

/**
 * Serializes the session cookie — the WRITE side of `parseCookieHeader`, kept in
 * the same file for the reason stated above: the name and the attributes that
 * make channel 1 trustworthy must not drift from the parser that trusts it.
 *
 * There is no `@fastify/cookie` in this repo, and adding one for two functions
 * would be the larger change; a `Set-Cookie` value is a well-specified string, so
 * it is built here as pure data and the route writes it with `reply.header`.
 *
 * The attributes are the point:
 *
 * - **`HttpOnly`** — script cannot read the token back. This is exactly the
 *   property `connectionParams` gives up, and the reason that channel is last.
 * - **`SameSite=Lax`** — sent on top-level navigations (so the OAuth redirect
 *   lands authenticated) but not on cross-site subrequests, which is CSRF cover
 *   for everything except top-level GETs.
 * - **`Secure`** — caller's choice, because the reference runs over plain HTTP
 *   locally and a `Secure` cookie would simply never come back. The composition
 *   root decides from the deploy stage; production must pass `true`.
 * - **`Expires`** — mirrors the row's `expiresAt`, so a browser stops sending a
 *   token the server would reject anyway. The instant is passed IN; this function
 *   reads no clock.
 */
export function serializeSessionCookie(
  token: string,
  expiresAt: Date,
  options: { readonly secure: boolean },
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** One arrival channel — the `UserStatus` analogue: the union derived FROM the list. */
export type CredentialChannel = (typeof CREDENTIAL_PRECEDENCE)[number];

/** The graphql-ws connection param crepe uses; see channel 3 above. */
const ACCESS_TOKEN_PARAM = 'accessToken';

/** The one auth scheme we accept, lowercased — RFC 7235 schemes are case-insensitive. */
const BEARER_SCHEME = 'bearer';

/**
 * Parses a raw `Cookie` header into name→value pairs. TOTAL: any string in, a
 * record out, never a throw — a header is untrusted input, and a malformed one
 * means "no cookies", never a 500.
 *
 * There is NO `@fastify/cookie` in this repo, and that is deliberate: reading
 * one header is ~15 lines of pure, property-testable string work, whereas the
 * plugin is a request-decorator that only the HTTP transport could reach — and
 * the graphql-ws path needs the same parse (CONVENTIONS §5's "the graduation
 * rule": a dependency is earned by its first real content).
 *
 * The rules, each one a decision a hostile header can probe:
 *  - split on `;`, then split each pair at the FIRST `=` only — a base64 value
 *    ends in `=` padding, and cutting on the last one would truncate it;
 *  - trim the name and the raw value, since `; ` separators are conventional
 *    but not guaranteed;
 *  - skip a fragment with no `=` (an attribute crumb like `Secure`) and one
 *    with an empty name — neither can be looked up, so neither is a cookie;
 *  - `decodeURIComponent` the value, falling back to the RAW bytes when it
 *    throws (`%zz` is a `URIError`), because totality outranks strictness;
 *  - on a duplicate name keep the FIRST occurrence, which is the narrowest-path
 *    cookie browsers send first and the choice that stops a later, attacker-set
 *    cookie from shadowing the real session.
 *
 * Values are collected in a `Map` and materialized with `Object.fromEntries`, so
 * a hostile `__proto__=x` pair becomes an ordinary OWN property instead of
 * touching any prototype.
 */
export function parseCookieHeader(header: string): Record<string, string> {
  const jar = new Map<string, string>();
  for (const fragment of header.split(';')) {
    const separator = fragment.indexOf('=');
    if (separator < 0) continue;
    const name = fragment.slice(0, separator).trim();
    if (name.length === 0 || jar.has(name)) continue;
    jar.set(name, decodeCookieValue(fragment.slice(separator + 1).trim()));
  }
  return Object.fromEntries(jar);
}

/** `decodeURIComponent` made total: a bad escape yields the raw bytes, not a `URIError`. */
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The candidacy rule, named once and deferred to by every channel
 * (CONVENTIONS §3, "name the rule, use it everywhere"): a token counts only if
 * it is non-empty AFTER trimming, and the trimmed form is what we mint. Trim is
 * the whole normalization — unlike `parseEmail` there is no lowercasing, because
 * a token is opaque bytes and case is significant.
 */
function usableToken(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `Authorization: Bearer <token>` — EXACTLY two space-separated parts, scheme
 * compared case-insensitively. Strict on purpose: anything else (`Basic …`, a
 * bare token, a scheme with an embedded space) is not a bearer credential, and
 * saying so by returning `null` lets the next channel answer rather than
 * failing the whole request.
 */
function readBearerToken(header: string): string | null {
  const parts = header.trim().split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme?.toLowerCase() !== BEARER_SCHEME) return null;
  return usableToken(token);
}

/**
 * The legacy graphql-ws channel. `connectionParams` is whatever JSON the client
 * put on the wire, so it arrives as `unknown` and is narrowed DEFENSIVELY: a
 * non-null, non-array object carrying an OWN `accessToken` of type string.
 * `Object.hasOwn` is the load-bearing check — a token inherited through a
 * `__proto__` payload is not something the client "sent", and treating it as one
 * is how prototype pollution turns into an auth bypass.
 */
function readAccessTokenParam(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  if (!Object.hasOwn(params, ACCESS_TOKEN_PARAM)) return null;
  const value = (params as Record<string, unknown>)[ACCESS_TOKEN_PARAM];
  return typeof value === 'string' ? usableToken(value) : null;
}

/**
 * One reader per channel, keyed by name so the `Record` is exhaustive: adding a
 * `CredentialChannel` without a reader here is a compile error. Each reader is
 * total and returns `null` for "this channel has nothing usable", which is what
 * makes the fall-through in `parseCredential` a plain loop.
 */
const READ_CHANNEL: Record<CredentialChannel, (source: CredentialSource) => string | null> = {
  cookie: ({ cookieHeader }) =>
    cookieHeader === undefined
      ? null
      : usableToken(parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME]),
  bearer: ({ authorization }) =>
    authorization === undefined ? null : readBearerToken(authorization),
  connectionParams: ({ connectionParams }) => readAccessTokenParam(connectionParams),
};

/**
 * Smart constructor: walks `CREDENTIAL_PRECEDENCE` and brands the first usable
 * token. TOTAL — every input, hostile ones included, yields a `Credential` or
 * `null`; it NEVER throws, because "no credential" is the anonymous request, not
 * an error (see the module block's divergence note).
 *
 * A blank or unusable value in a higher-precedence channel FALLS THROUGH rather
 * than short-circuiting: a stale `sid=` cookie left behind by a logout must not
 * mask a perfectly good `Authorization` header. Precedence therefore ranks
 * *usable* tokens, not merely present fields.
 */
export function parseCredential(source: CredentialSource): Credential | null {
  for (const channel of CREDENTIAL_PRECEDENCE) {
    const candidate = READ_CHANNEL[channel](source);
    if (candidate !== null) return candidate as Credential;
  }
  return null;
}
