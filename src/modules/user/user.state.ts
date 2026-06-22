/**
 * User status state machine and invariants.
 *
 * SQLite has no native enums, so `User.status` is stored as a string. This
 * module is the single source of truth for the allowed values and transitions,
 * keeping that invariant out of both the database and the resolvers.
 */

import { DomainError } from '../../errors.js';

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Allowed transitions. `DEACTIVATED` is terminal. */
const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: [],
};

export function isUserStatus(value: string): value is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: UserStatus, to: UserStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isActive(status: UserStatus): boolean {
  return status === 'ACTIVE';
}

export class InvalidStatusTransitionError extends DomainError {
  constructor(
    readonly from: UserStatus,
    readonly to: UserStatus,
  ) {
    super(`Invalid user status transition: ${from} -> ${to}`, 'INVALID_STATUS_TRANSITION');
  }
}

/**
 * Asserts a transition is legal. Transitioning to the same status is a no-op
 * (idempotent); any other disallowed transition throws.
 */
export function assertTransition(from: UserStatus, to: UserStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new InvalidStatusTransitionError(from, to);
  }
}
