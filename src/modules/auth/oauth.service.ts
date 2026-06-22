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
 * dependencies are injected, so this class is unit-testable with a fake
 * provider and a throwaway database.
 */
export class OAuthService {
  private readonly users: UserService;
  private readonly google: GoogleOAuthClient;

  constructor(deps: OAuthServiceDeps) {
    this.users = deps.users;
    this.google = deps.google;
  }

  /** Step 1: the consent-screen URL the browser is redirected to. */
  startUrl(state: string): string {
    return this.google.buildAuthUrl(state);
  }

  /**
   * Steps 2-4: exchange the code, fetch the profile, and provision the user.
   *
   * The first two steps are delegated to the (stubbed) provider; the third is
   * the point of this example — a user is created via the **user module**, the
   * same `UserService` the GraphQL `createUser` mutation uses, so both surfaces
   * share one code path and one set of invariants.
   */
  async completeLogin(callback: OAuthCallback): Promise<User> {
    const tokens = await this.google.exchangeCode(callback.code);
    const profile = await this.google.fetchProfile(tokens);
    return this.users.findOrCreateByEmail({ email: profile.email, name: profile.name });
  }
}
