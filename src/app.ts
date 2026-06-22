import type { PrismaClient } from '@prisma/client';
import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { GraphQLError } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { createContextFactory, createServices } from './context.js';
import { isDomainError } from './errors.js';
import { createPrismaClient } from './prisma.js';
import { schema } from './schema.js';

/** Context Yoga receives from Fastify per request. */
export interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface BuildAppOptions {
  /** Inject a PrismaClient (e.g. pointing at a test database). */
  prisma?: PrismaClient;
  /** Toggle Fastify request logging (default: true). */
  logger?: boolean;
}

/**
 * Composition root: constructs the Prisma client and services, injects them
 * into the GraphQL context, and assembles the Fastify + Yoga app.
 *
 * Returns the (not-yet-listening) app so tests can import and drive it without
 * binding a port. See src/server.ts for the process entrypoint.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const prisma = options.prisma ?? createPrismaClient();
  const services = createServices(prisma);
  const app = fastify({ logger: options.logger ?? true });

  const yoga = createYoga<ServerContext>({
    schema,
    graphqlEndpoint: '/graphql',
    context: createContextFactory({ prisma, services }),
    // Expected domain errors reach the client with their message + code;
    // everything else is masked as a generic internal error.
    maskedErrors: {
      maskError(error, message) {
        // Unwrap the located GraphQLError's originalError structurally (no
        // `instanceof`, which can fail across module realms in test runners).
        const original = (error as { originalError?: unknown })?.originalError ?? error;
        if (isDomainError(original)) {
          return new GraphQLError(original.message, { extensions: { code: original.code } });
        }
        return new GraphQLError(message);
      },
    },
    logging: {
      debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
      info: (...args) => args.forEach((arg) => app.log.info(arg)),
      warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
      error: (...args) => args.forEach((arg) => app.log.error(arg)),
    },
  });

  // Let Fastify forward multipart requests to Yoga (needed for file uploads).
  app.addContentTypeParser('multipart/form-data', {}, (_req, _payload, done) => done(null));

  app.route({
    url: yoga.graphqlEndpoint,
    method: ['GET', 'POST', 'OPTIONS'],
    handler: (req, reply) => yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
  });

  // Non-GraphQL routes (e.g. a payment provider webhook) would be registered
  // here, calling into a service — they share the same `services` container:
  //   registerPaymentWebhook(app, services.payment)

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return { app, prisma, services, yoga };
}
