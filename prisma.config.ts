import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 (and Node) no longer auto-load .env — load it explicitly so the
// Prisma CLI (migrate, studio, ...) can read DATABASE_URL.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

type Env = {
  DATABASE_URL: string;
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
});
