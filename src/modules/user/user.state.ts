/**
 * User status state machine and invariants.
 *
 * This module is the single source of truth for the allowed *transitions*.
 * The allowed *value set* is additionally enforced by a DB CHECK constraint
 * (see the migrations), so a corrupt write fails at the database; a corrupt
 * READ — which the CHECK makes unreachable — fails loudly in `parseUserStatus`
 * instead of being coerced to some default.
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

/**
 * An unknown status came out of the database — corruption, not a client error,
 * so this is a plain (masked) Error rather than a DomainError.
 */
export class UnknownUserStatusError extends Error {
  constructor(readonly value: string) {
    super(`Unknown user status read from the database: ${JSON.stringify(value)}`);
    this.name = 'UnknownUserStatusError';
  }
}

/** Parse, don't validate: DB strings become `UserStatus` only through here. */
export function parseUserStatus(value: string): UserStatus {
  if (!isUserStatus(value)) {
    throw new UnknownUserStatusError(value);
  }
  return value;
}

export function canTransition(from: UserStatus, to: UserStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
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

/** What a status change must do: nothing (idempotent repeat) or one CAS write. */
export type TransitionPlan =
  | { kind: 'noop' }
  | { kind: 'transition'; from: UserStatus; to: UserStatus };

/**
 * Decides a status change (the single-row degenerate case of the plan
 * pattern): validates the move and returns whether a write is needed — so the
 * shell branches only on the plan, never on the domain.
 */
export function planTransition(from: UserStatus, to: UserStatus): TransitionPlan {
  assertTransition(from, to);
  return from === to ? { kind: 'noop' } : { kind: 'transition', from, to };
}
