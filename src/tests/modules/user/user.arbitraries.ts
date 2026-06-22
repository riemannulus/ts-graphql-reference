import { fc } from '@fast-check/vitest';
import { USER_STATUSES } from '../../../modules/user/user.state.js';
import { isEmail } from '../../../modules/user/user.value.js';

/** Any user status. */
export const arbUserStatus = fc.constantFrom(...USER_STATUSES);

// An "atom" is a non-empty run of characters with no whitespace, '@' or '.'.
const arbAtom = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[\s@.]/g, ''))
  .filter((s) => s.length > 0);

/** Valid emails that satisfy `isEmail` (local@domain.tld), already normalized. */
export const arbValidEmail = fc
  .tuple(arbAtom, arbAtom, arbAtom)
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`.toLowerCase());

/** Strings that are NOT valid emails (after normalization). */
export const arbInvalidEmail = fc
  .string()
  .filter((s) => !isEmail(s.trim().toLowerCase()));

/** Valid input for UserService.create. */
export const arbCreateUserInput = fc.record({
  email: arbValidEmail,
  name: fc.option(fc.string(), { nil: null }),
});
