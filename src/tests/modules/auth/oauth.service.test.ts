import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleOAuthClient } from '../../../modules/auth/oauth.provider.js';
import { createOAuthService, type OAuthService } from '../../../modules/auth/oauth.service.js';
import { parseOAuthCallback, type OAuthProfile } from '../../../modules/auth/oauth.value.js';
import { createUserService } from '../../../modules/user/user.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();

/** Stands in for the unimplemented stub; a port fake is just an object literal. */
function fakeGoogleClient(profile: OAuthProfile): GoogleOAuthClient {
  return {
    buildAuthUrl: (state) => `https://accounts.example.test/consent?state=${state}`,
    exchangeCode: () => Promise.resolve({ accessToken: 'fake-access-token' }),
    fetchProfile: () => Promise.resolve(profile),
  };
}

function oauthFor(profile: OAuthProfile): OAuthService {
  return createOAuthService({
    users: createUserService({ rw: prisma, ro: prisma }),
    google: fakeGoogleClient(profile),
  });
}

const callback = parseOAuthCallback({ code: 'auth-code', state: 'csrf-state' });

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('OAuthService.completeLogin', () => {
  it('creates a user from the provider profile on first login', async () => {
    const oauth = oauthFor({ providerAccountId: 'g-1', email: 'alice@example.com', name: 'Alice' });
    const user = await oauth.completeLogin(callback);
    expect(user.email).toBe('alice@example.com');
    expect(user.name).toBe('Alice');
    expect(user.status).toBe('ACTIVE');
    expect(await prisma.user.count()).toBe(1);
  });

  it('is idempotent: a repeat login reuses the existing user', async () => {
    const oauth = oauthFor({ providerAccountId: 'g-1', email: 'bob@example.com', name: 'Bob' });
    const first = await oauth.completeLogin(callback);
    const second = await oauth.completeLogin(callback);
    expect(second.id).toBe(first.id);
    expect(await prisma.user.count()).toBe(1);
  });
});
