import { test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { InvalidEmailError, isEmail, parseEmail } from '../../modules/user/user.value.js';
import { arbInvalidEmail, arbValidEmail } from '../../testing/arbitraries/user.js';

describe('Email value object invariants', () => {
  test.prop([arbValidEmail])('parses any valid email; the result satisfies isEmail', (raw) => {
    expect(isEmail(parseEmail(raw))).toBe(true);
  });

  test.prop([arbValidEmail])('normalization is idempotent (parse∘parse = parse)', (raw) => {
    const once = parseEmail(raw);
    expect(parseEmail(once)).toBe(once);
  });

  test.prop([arbValidEmail])('is insensitive to surrounding whitespace and case', (raw) => {
    expect(parseEmail(`  ${raw.toUpperCase()}  `)).toBe(parseEmail(raw));
  });

  test.prop([arbInvalidEmail])('rejects non-emails with InvalidEmailError', (raw) => {
    expect(() => parseEmail(raw)).toThrow(InvalidEmailError);
  });
});
