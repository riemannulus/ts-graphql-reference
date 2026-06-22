import type { OAuthProfile } from './oauth.value.js';

/** Tokens returned by the provider's token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  idToken?: string;
  expiresIn?: number;
}

/**
 * Port for talking to a specific OAuth provider (Google here).
 *
 * `OAuthService` depends on this interface, never on a concrete HTTP client, so
 * the provider integration can be left unimplemented in production and swapped
 * for a fake in tests — without touching the routing, parsing, or
 * user-provisioning logic that surrounds it.
 */
export interface GoogleOAuthClient {
  /** Build the consent-screen URL the browser is redirected to (step 1). */
  buildAuthUrl(state: string): string;
  /** Exchange the authorization `code` for tokens (step 2). */
  exchangeCode(code: string): Promise<OAuthTokens>;
  /** Fetch the signed-in account's profile using the tokens (step 3). */
  fetchProfile(tokens: OAuthTokens): Promise<OAuthProfile>;
}

/**
 * Production binding — intentionally left UNIMPLEMENTED.
 *
 * Wiring this up means dropping in Google's endpoints (the consent URL at
 * `accounts.google.com/o/oauth2/v2/auth`, the token endpoint, and the userinfo
 * endpoint) together with your client id/secret and redirect URI. Everything
 * around these three calls — the routes, callback parsing, user provisioning,
 * and dependency injection — is complete and tested; only the provider HTTP is
 * left as an exercise. Tests inject a fake implementation instead (see the auth
 * tests), which is how the end-to-end wiring is exercised without real network.
 */
export class StubGoogleOAuthClient implements GoogleOAuthClient {
  buildAuthUrl(_state: string): string {
    throw new Error('GoogleOAuthClient.buildAuthUrl not implemented: configure Google OAuth');
  }

  exchangeCode(_code: string): Promise<OAuthTokens> {
    throw new Error('GoogleOAuthClient.exchangeCode not implemented: configure Google OAuth');
  }

  fetchProfile(_tokens: OAuthTokens): Promise<OAuthProfile> {
    throw new Error('GoogleOAuthClient.fetchProfile not implemented: configure Google OAuth');
  }
}
