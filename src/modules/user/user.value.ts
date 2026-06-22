import { DomainError } from '../../errors.js';

/**
 * Email value object (parse, don't validate).
 *
 * `Email` is a branded string: once a value has this type, the invariant
 * "looks like a normalized email" holds by construction — downstream code never
 * re-validates. The only way to obtain one is `parseEmail`.
 */
declare const emailBrand: unique symbol;
export type Email = string & { readonly [emailBrand]: 'Email' };

// Deliberately simple; real systems should use a vetted validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvalidEmailError extends DomainError {
  constructor(readonly value: string) {
    super(`Invalid email address: ${JSON.stringify(value)}`, 'INVALID_EMAIL');
  }
}

/** Predicate form of the invariant — total over all strings. */
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/**
 * Smart constructor: normalizes (trim + lowercase) and validates a raw string,
 * returning a branded `Email` or throwing `InvalidEmailError`.
 */
export function parseEmail(value: string): Email {
  const normalized = value.trim().toLowerCase();
  if (!isEmail(normalized)) {
    throw new InvalidEmailError(value);
  }
  return normalized as Email;
}
