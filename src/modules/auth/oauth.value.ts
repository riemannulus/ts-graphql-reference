import { DomainError } from '../../errors.js';

/**
 * OAuth value objects (parse, don't validate).
 *
 * After the user consents, the provider redirects the browser back to our
 * callback URL with query parameters. Those parameters are untrusted input;
 * `parseOAuthCallback` is the single boundary that turns them into a typed
 * `OAuthCallback`, so every step downstream receives a value whose invariants
 * ("has a non-empty code and state") already hold — the HTTP analogue of how
 * `parseEmail` guards the GraphQL layer.
 */

/** Raw callback query as Fastify hands it to us: untrusted, every field unknown. */
export interface OAuthCallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
}

/**
 * A validated OAuth callback. Obtainable only via `parseOAuthCallback`, so a
 * value of this type is guaranteed to carry both a `code` and a `state`.
 */
export interface OAuthCallback {
  readonly code: string;
  readonly state: string;
}

/** The normalized identity a provider returns for the signed-in account. */
export interface OAuthProfile {
  /** The provider's stable account id (e.g. Google's `sub` claim). */
  providerAccountId: string;
  email: string;
  name?: string | null;
}

export class OAuthError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_OAUTH_CALLBACK');
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses the provider's callback query into a typed `OAuthCallback`, or throws
 * an `OAuthError`. Total over all inputs: any shape of query is handled.
 */
export function parseOAuthCallback(query: OAuthCallbackQuery): OAuthCallback {
  // The provider signals a denied or aborted consent with `?error=...`.
  const error = asNonEmptyString(query.error);
  if (error) {
    throw new OAuthError(`OAuth provider returned an error: ${error}`);
  }
  const code = asNonEmptyString(query.code);
  const state = asNonEmptyString(query.state);
  if (!code || !state) {
    throw new OAuthError('OAuth callback is missing the code or state parameter');
  }
  return { code, state };
}
