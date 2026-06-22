import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { OAuthError, parseOAuthCallback } from '../../../modules/auth/oauth.value.js';

// Each field may be absent, an empty/non-empty string, or non-string noise.
const arbField = fc.oneof(
  fc.string(),
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
);

const arbQuery = fc.record(
  { code: arbField, state: arbField, error: arbField },
  { requiredKeys: [] },
);

describe('parseOAuthCallback invariants', () => {
  test.prop([arbQuery])('is total: returns a valid callback or throws OAuthError', (query) => {
    try {
      const cb = parseOAuthCallback(query);
      // A returned callback guarantees both fields are present, non-empty strings.
      expect(typeof cb.code).toBe('string');
      expect(cb.code.length).toBeGreaterThan(0);
      expect(typeof cb.state).toBe('string');
      expect(cb.state.length).toBeGreaterThan(0);
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthError);
    }
  });

  test.prop([fc.string({ minLength: 1 }), fc.string({ minLength: 1 })])(
    'accepts any non-empty code and state',
    (code, state) => {
      expect(parseOAuthCallback({ code, state })).toEqual({ code, state });
    },
  );

  test.prop([
    fc.string({ minLength: 1 }),
    fc.string({ minLength: 1 }),
    fc.string({ minLength: 1 }),
  ])('a provider error rejects regardless of code/state', (error, code, state) => {
    expect(() => parseOAuthCallback({ code, state, error })).toThrow(OAuthError);
  });
});
