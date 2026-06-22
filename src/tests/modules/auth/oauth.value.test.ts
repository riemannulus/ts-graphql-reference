import { describe, expect, it } from 'vitest';
import { OAuthError, parseOAuthCallback } from '../../../modules/auth/oauth.value.js';

describe('parseOAuthCallback', () => {
  it('returns the code and state for a valid callback', () => {
    expect(parseOAuthCallback({ code: 'auth-code', state: 'csrf-state' })).toEqual({
      code: 'auth-code',
      state: 'csrf-state',
    });
  });

  it('throws when the code is missing', () => {
    expect(() => parseOAuthCallback({ state: 'csrf-state' })).toThrow(OAuthError);
  });

  it('throws when the state is missing', () => {
    expect(() => parseOAuthCallback({ code: 'auth-code' })).toThrow(OAuthError);
  });

  it('treats non-string params as missing', () => {
    expect(() => parseOAuthCallback({ code: 123, state: true })).toThrow(OAuthError);
  });

  it('surfaces a provider error param as an OAuthError', () => {
    expect(() => parseOAuthCallback({ error: 'access_denied' })).toThrow(/access_denied/);
  });

  it('throws an OAuthError carrying the INVALID_OAUTH_CALLBACK code', () => {
    expect.assertions(2);
    try {
      parseOAuthCallback({});
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthError);
      expect((e as OAuthError).code).toBe('INVALID_OAUTH_CALLBACK');
    }
  });
});
