import './env.js';
import { buildApp } from './app.js';

const { app } = buildApp();
const port = Number(process.env.PORT ?? 4000);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`🚀 GraphQL ready at http://localhost:${port}/graphql`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

const shutdown = async () => {
  await app.close(); // triggers the onClose hook → prisma.$disconnect()
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
