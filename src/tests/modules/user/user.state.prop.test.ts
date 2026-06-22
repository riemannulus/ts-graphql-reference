import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidStatusTransitionError,
} from '../../../modules/user/user.state.js';
import { arbUserStatus } from './user.arbitraries.js';

describe('user.state invariants', () => {
  test.prop([arbUserStatus])('a transition to the same status is always a no-op', (s) => {
    expect(() => assertTransition(s, s)).not.toThrow();
  });

  test.prop([arbUserStatus])('DEACTIVATED is terminal — no transition out of it', (to) => {
    expect(canTransition('DEACTIVATED', to)).toBe(false);
  });

  test.prop([arbUserStatus, arbUserStatus])(
    'assertTransition agrees with canTransition for distinct statuses',
    (from, to) => {
      fc.pre(from !== to);
      let threw = false;
      try {
        assertTransition(from, to);
      } catch {
        threw = true;
      }
      expect(threw).toBe(!canTransition(from, to));
    },
  );

  test.prop([arbUserStatus, arbUserStatus])(
    'assertTransition only ever throws InvalidStatusTransitionError (totality)',
    (from, to) => {
      try {
        assertTransition(from, to);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStatusTransitionError);
      }
    },
  );
});
