import type { Db } from './db/db.js';
import { type Clock, systemClock } from './foundation/clock.js';
import { type GoogleOAuthClient, stubGoogleOAuthClient } from './modules/auth/oauth.provider.js';
import { createOAuthService } from './modules/auth/oauth.service.js';
import { createFeatureFlagService } from './modules/feature-flag/feature-flag.service.js';
import { createOnboardingService } from './modules/onboarding/onboarding.service.js';
import { createPointService } from './modules/point/point.service.js';
import {
  type PostSearchIndex,
  stubPostSearchIndex,
} from './modules/search/post-search.provider.js';
import { createPostSearchService } from './modules/search/post-search.service.js';
import { createUserService } from './modules/user/user.service.js';

/** Optional overrides for dependencies that have a default production binding. */
export interface CreateServicesOptions {
  /**
   * Google OAuth client. Production binds an unimplemented stub; tests inject a
   * fake. The OAuth service depends on the port, not a concrete client.
   */
  googleOAuth?: GoogleOAuthClient;
  /**
   * Post search index. Production binds an unimplemented stub; tests inject a
   * fake in-memory index. The search service depends on the port.
   */
  postSearchIndex?: PostSearchIndex;
  /**
   * The clock use-cases read "now" from (see foundation/clock.ts). Production
   * uses `systemClock`; tests inject a fixed clock (src/tests/support/clock.ts)
   * so time-sensitive use-cases (point expiry, the flag window) are
   * deterministic. Bound once here and shared by every service that reads time.
   */
  clock?: Clock;
}

/**
 * Builds the service container — the app's domain use-cases assembled once.
 *
 * This is the SINGLE place a module's service is registered AND where
 * cross-service dependencies are wired: the OAuth service provisions users
 * through the user service, so the two are composed here, once, rather than
 * reaching for a global. It is deliberately transport-agnostic — the GraphQL
 * context and the OAuth REST route consume this SAME container (see app.ts) —
 * which is why it lives beside the composition root, not under `graphql/`.
 *
 * The `Services` type is derived from this function's return value, so adding a
 * service here flows into every consumer (the GraphQL context type included)
 * with no second edit.
 *
 * Services receive the full `Db` but by convention only ever use `db.rw`:
 * use-cases decide on state they read themselves, and deciding on
 * replica-lagged state would be wrong. The `ro` handle serves the query path
 * (schema → repo), not use-cases.
 */
export function createServices(db: Db, options: CreateServicesOptions = {}) {
  const clock = options.clock ?? systemClock;
  const user = createUserService(db);
  const point = createPointService(db, clock);
  const auth = createOAuthService({
    users: user,
    google: options.googleOAuth ?? stubGoogleOAuthClient,
  });
  const onboarding = createOnboardingService({ db });
  const postSearch = createPostSearchService({
    index: options.postSearchIndex ?? stubPostSearchIndex,
  });
  const featureFlag = createFeatureFlagService(db, clock);
  return { user, point, auth, onboarding, postSearch, featureFlag };
}

/** The service container, injected into every resolver and the OAuth route. */
export type Services = ReturnType<typeof createServices>;
