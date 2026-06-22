import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // Each test file builds its own in-process PGlite database (helpers.ts), so
    // files are fully isolated and can run in parallel.
  },
});
