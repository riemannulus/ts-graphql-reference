import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidStatusTransitionError,
  isUserStatus,
} from '../modules/user/user.state.js';

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
});
