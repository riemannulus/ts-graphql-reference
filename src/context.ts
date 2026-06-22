import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type GoogleOAuthClient, StubGoogleOAuthClient } from './modules/auth/oauth.provider.js';
import { OAuthService } from './modules/auth/oauth.service.js';
import { PostService } from './modules/post/post.service.js';
import { UserService } from './modules/user/user.service.js';

/** Optional overrides for dependencies that have a default production binding. */
export interface CreateServicesOptions {
  /**
   * Google OAuth client. Production binds an unimplemented stub; tests inject a
   * fake. The OAuth service depends on the port, not a concrete client.
   */
  googleOAuth?: GoogleOAuthClient;
}

/**
 * Builds the service container.
 *
 * This is the SINGLE place a module's service is registered: the `Services`
 * type is derived from this function's return type, so adding a service here
 * automatically flows into the GraphQL context type — no second edit needed.
 *
 * It is also where cross-service dependencies are composed: `OAuthService`
 * provisions users through `UserService`, so the two are wired together here,
 * once, rather than reaching for a global.
 */
export function createServices(prisma: PrismaClient, options: CreateServicesOptions = {}) {
  const user = new UserService(prisma);
  const post = new PostService(prisma);
  const auth = new OAuthService({
    users: user,
    google: options.googleOAuth ?? new StubGoogleOAuthClient(),
  });
  return { user, post, auth };
}

/** Services injected into every resolver (derived from `createServices`). */
export type Services = ReturnType<typeof createServices>;

/** Per-request GraphQL context handed to every resolver. */
export interface Context {
  prisma: PrismaClient;
  services: Services;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Long-lived dependencies created once in the composition root (app.ts). */
export interface ContextDeps {
  prisma: PrismaClient;
  services: Services;
}

/**
 * Builds the per-request context factory.
 *
 * The expensive, long-lived dependencies (prisma, services) are created once
 * and closed over here; only request-scoped values (req/reply) are added per
 * call. This is the single place where dependencies enter the GraphQL layer.
 */
export function createContextFactory(deps: ContextDeps) {
  return ({ req, reply }: { req: FastifyRequest; reply: FastifyReply }): Context => ({
    prisma: deps.prisma,
    services: deps.services,
    req,
    reply,
  });
}
