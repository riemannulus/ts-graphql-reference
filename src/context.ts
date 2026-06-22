import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PostService } from './modules/post/post.service.js';
import type { UserService } from './modules/user/user.service.js';

/**
 * Services injected into every resolver via the GraphQL context. Resolvers call
 * `ctx.services.user.*` instead of touching Prisma directly, keeping business
 * logic out of the schema layer.
 */
export interface Services {
  user: UserService;
  post: PostService;
}

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
