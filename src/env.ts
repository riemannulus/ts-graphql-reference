import { existsSync } from 'node:fs';

// Prisma 7 (and Node) no longer auto-load .env at runtime. Load it explicitly
// before anything reads process.env (import this first in the entrypoint).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
