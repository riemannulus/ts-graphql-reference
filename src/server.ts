import fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createYoga } from 'graphql-yoga';
import { prisma } from './builder.js';
import { schema } from './schema.js';

const app = fastify({ logger: true });

/** Context Yoga receives from Fastify per request. */
export interface ServerContext {
  req: FastifyRequest;
  reply: FastifyReply;
}

const yoga = createYoga<ServerContext>({
  schema,
  graphqlEndpoint: '/graphql',
  // Surface Yoga's logs through Fastify's logger.
  logging: {
    debug: (...args) => args.forEach((arg) => app.log.debug(arg)),
    info: (...args) => args.forEach((arg) => app.log.info(arg)),
    warn: (...args) => args.forEach((arg) => app.log.warn(arg)),
    error: (...args) => args.forEach((arg) => app.log.error(arg)),
  },
  // Expose the shared Prisma client to every resolver via the GraphQL context.
  context: () => ({ prisma }),
});

// Let Fastify forward multipart requests to Yoga (needed for file uploads).
app.addContentTypeParser('multipart/form-data', {}, (_req, _payload, done) => done(null));

app.route({
  url: yoga.graphqlEndpoint,
  method: ['GET', 'POST', 'OPTIONS'],
  handler: (req, reply) => yoga.handleNodeRequestAndResponse(req, reply, { req, reply }),
});

const port = Number(process.env.PORT ?? 4000);

async function main() {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`🚀 GraphQL ready at http://localhost:${port}${yoga.graphqlEndpoint}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

async function shutdown() {
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
