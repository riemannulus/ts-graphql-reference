import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env.
// Values already present in the environment (CI, EB) take precedence.
if (existsSync(".env")) process.loadEnvFile();

export default defineConfig({
    migrations: { path: "prisma/migrations" },
    // env() throws when unset, which would break `prisma generate` in CI.
    datasource: { url: process.env.DATABASE_URL ?? "" },
});
