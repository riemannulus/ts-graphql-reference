import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidStatusTransitionError,
  isUserStatus,
  parseUserStatus,
  planTransition,
  UnknownUserStatusError,
} from '../../../modules/user/user.state.js';

describe('user.state', () => {
  it('recognizes valid statuses', () => {
    expect(isUserStatus('ACTIVE')).toBe(true);
    expect(isUserStatus('NOPE')).toBe(false);
  });

  it('allows legal transitions', () => {
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'DEACTIVATED')).toBe(true);
  });

  it('rejects transitions out of the terminal DEACTIVATED state', () => {
    expect(canTransition('DEACTIVATED', 'ACTIVE')).toBe(false);
    expect(() => assertTransition('DEACTIVATED', 'ACTIVE')).toThrow(InvalidStatusTransitionError);
  });

  it('treats a same-status transition as a no-op', () => {
    expect(() => assertTransition('ACTIVE', 'ACTIVE')).not.toThrow();
  });

  it('parseUserStatus refuses an out-of-set value instead of coercing it', () => {
    expect(parseUserStatus('SUSPENDED')).toBe('SUSPENDED');
    expect(() => parseUserStatus('CORRUPTED')).toThrow(UnknownUserStatusError);
  });

  it('planTransition returns a noop for a repeat, a CAS plan for a move, and throws otherwise', () => {
    expect(planTransition('ACTIVE', 'ACTIVE')).toEqual({ kind: 'noop' });
    expect(planTransition('ACTIVE', 'SUSPENDED')).toEqual({
      kind: 'transition',
      from: 'ACTIVE',
      to: 'SUSPENDED',
    });
    expect(() => planTransition('DEACTIVATED', 'ACTIVE')).toThrow(InvalidStatusTransitionError);
  });
});
