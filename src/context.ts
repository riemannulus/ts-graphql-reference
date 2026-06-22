import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PostService } from './modules/post/post.service.js';
import { UserService } from './modules/user/user.service.js';

/**
 * Builds the service container.
 *
 * This is the SINGLE place a module's service is registered: the `Services`
 * type is derived from this function's return type, so adding a service here
 * automatically flows into the GraphQL context type — no second edit needed.
 */
export function createServices(prisma: PrismaClient) {
  return {
    user: new UserService(prisma),
    post: new PostService(prisma),
  };
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
