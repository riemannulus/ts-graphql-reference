import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { TEST_DATABASE_URL, TEST_DB_FILE } from './helpers.js';

/**
 * Runs once before the whole test run: applies the Prisma schema to a fresh
 * SQLite file. The explicit DATABASE_URL wins over .env (loadEnvFile does not
 * override existing env vars), so this targets test.db, not dev.db.
 */
export default function setup() {
  rmSync(TEST_DB_FILE, { force: true });
  // Apply the committed migrations to the fresh test DB (deterministic, and
  // exercises the same migrations the app ships with).
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  return () => {
    rmSync(TEST_DB_FILE, { force: true });
  };
}
