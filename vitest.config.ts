import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // Each test file builds its own in-process PGlite database (helpers.ts), so
    // files are fully isolated and can run in parallel.
    //
    // The 5s default is the wrong unit for this suite. A property test is ONE
    // vitest test that replays a hundred iterations, each doing real database
    // work, and every file's PGlite competes for the same cores — so the
    // per-test budget has to cover the whole replay under full contention, not
    // one round trip on an idle machine. 30s is generous enough that adding a
    // test file never makes an unrelated property test flake, and still short
    // enough to fail fast on a genuine hang.
    testTimeout: 30_000,
  },
});
