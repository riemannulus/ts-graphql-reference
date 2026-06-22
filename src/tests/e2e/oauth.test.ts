import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { GoogleOAuthClient, OAuthTokens } from '../../modules/auth/oauth.provider.js';
import type { OAuthProfile } from '../../modules/auth/oauth.value.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

/** Fake provider injected via buildApp so the callback runs without real network. */
class FakeGoogleClient implements GoogleOAuthClient {
  buildAuthUrl(state: string): string {
    return `https://accounts.example.test/consent?state=${state}`;
  }
  exchangeCode(_code: string): Promise<OAuthTokens> {
    return Promise.resolve({ accessToken: 'fake-access-token' });
  }
  fetchProfile(_tokens: OAuthTokens): Promise<OAuthProfile> {
    return Promise.resolve({ providerAccountId: 'g-1', email: 'oauth@example.com', name: 'OAuth User' });
  }
}

/** A provider whose token exchange fails — exercises the masked-error (500) path. */
class FailingGoogleClient implements GoogleOAuthClient {
  buildAuthUrl(state: string): string {
    return `https://accounts.example.test/consent?state=${state}`;
  }
  exchangeCode(_code: string): Promise<OAuthTokens> {
    return Promise.reject(new Error('google token endpoint is unavailable'));
  }
  fetchProfile(_tokens: OAuthTokens): Promise<OAuthProfile> {
    return Promise.resolve({ providerAccountId: 'g-1', email: 'unused@example.com' });
  }
}

const prisma = await makeTestPrisma();
const { app } = buildApp({ prisma, logger: false, googleOAuth: new FakeGoogleClient() });

// A second app with a failing provider, on its own database, for the 500 path.
const failPrisma = await makeTestPrisma();
const { app: failApp } = buildApp({
  prisma: failPrisma,
  logger: false,
  googleOAuth: new FailingGoogleClient(),
});

beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await app.close(); // onClose hook disconnects prisma
  await failApp.close();
});

describe('Google OAuth callback (non-GraphQL endpoint)', () => {
  it('provisions a user via the user module and returns it', async () => {
    const res = await app.inject({ method: 'GET', url: '/google/oauth/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('oauth@example.com');
    expect(body.status).toBe('ACTIVE');
    expect(typeof body.userId).toBe('number');
    expect(await prisma.user.count()).toBe(1);
  });

  it('is idempotent across repeat callbacks (same user)', async () => {
    const first = await app.inject({ method: 'GET', url: '/google/oauth/callback?code=a&state=s' });
    const second = await app.inject({ method: 'GET', url: '/google/oauth/callback?code=a&state=s' });
    expect(second.json().userId).toBe(first.json().userId);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects a callback missing code/state with a 400 domain error', async () => {
    const res = await app.inject({ method: 'GET', url: '/google/oauth/callback?state=xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_OAUTH_CALLBACK');
  });

  it('redirects to the consent screen when starting the flow', async () => {
    const res = await app.inject({ method: 'GET', url: '/google/oauth' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('accounts.example.test');
  });

  it('masks an unexpected provider failure as a 500 without leaking details', async () => {
    const res = await failApp.inject({
      method: 'GET',
      url: '/google/oauth/callback?code=abc&state=xyz',
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('INTERNAL');
    expect(body.message).toBe('Internal Server Error');
    // The underlying provider error message must not reach the client.
    expect(JSON.stringify(body)).not.toContain('token endpoint');
  });
});
