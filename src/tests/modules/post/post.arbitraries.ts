import { fc } from '@fast-check/vitest';

/** Fields for creating a post (the author is supplied per-test at runtime). */
export const arbCreatePostFields = fc.record({
  title: fc.string({ minLength: 1 }),
  content: fc.option(fc.string(), { nil: null }),
});
