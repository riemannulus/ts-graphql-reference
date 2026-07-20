import type { User } from '@prisma/client';
import type { UserService } from '../user/user.service.js';
import type { GoogleOAuthClient } from './oauth.provider.js';
import type { OAuthCallback } from './oauth.value.js';

export interface OAuthServiceDeps {
  users: UserService;
  google: GoogleOAuthClient;
}

/**
 * Orchestrates the Google OAuth login callback.
 *
 * It owns no transport details (that is the route's job) and no provider HTTP
 * details (that is the `GoogleOAuthClient` port's job): it just sequences the
 * provider calls and provisions the user through the user module. Both
 * dependencies are injected, so this is unit-testable with a fake provider and
 * a throwaway database.
 */
export function createOAuthService(deps: OAuthServiceDeps) {
  return {
    /** Step 1: the consent-screen URL the browser is redirected to. */
    startUrl(state: string): string {
      return deps.google.buildAuthUrl(state);
    },

    /**
     * Steps 2-4: exchange the code, fetch the profile, and provision the user.
     *
     * The first two steps are delegated to the (stubbed) provider; the third is
     * the point of this example — the user is provisioned via the **user
     * module** (its service, and through it the same `parseEmail` boundary and
     * repo write the GraphQL sign-up path uses), so both surfaces share the
     * module's invariants rather than reimplementing them.
     */
    async completeLogin(callback: OAuthCallback): Promise<User> {
      const tokens = await deps.google.exchangeCode(callback.code);
      const profile = await deps.google.fetchProfile(tokens);
      return deps.users.findOrCreateByEmail({ email: profile.email, name: profile.name });
    },
  };
}

export type OAuthService = ReturnType<typeof createOAuthService>;
