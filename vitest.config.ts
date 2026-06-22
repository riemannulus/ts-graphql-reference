import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    globalSetup: ['./src/tests/support/global-setup.ts'],
    // The SQLite test DB is a single shared file — avoid concurrent writers
    // across test files.
    fileParallelism: false,
  },
});
