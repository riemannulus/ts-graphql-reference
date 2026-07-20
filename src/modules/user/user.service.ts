import type { User } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { ConcurrentUpdateError } from '../../foundation/errors.js';
import * as userRepo from './user.repo.js';
import { parseUserStatus, planTransition, type UserStatus } from './user.state.js';
import { parseEmail } from './user.value.js';

export interface CreateUserInput {
  email: string;
  name?: string | null;
}

/** Parse at the boundary: an invalid email never reaches the database. */
function toWriteData(input: CreateUserInput): userRepo.UserWriteData {
  return { email: parseEmail(input.email), name: input.name ?? null };
}

/**
 * User use-cases. Reads that feed decisions and all writes run on the PRIMARY
 * (`db.rw`) — deciding on replica-lagged state would be wrong. Methods return
 * plain domain results; the GraphQL layer re-fetches with its own selection.
 *
 * Cross-module use-cases that need a user write inside THEIR transaction
 * (onboarding) compose `userRepo.createUser` directly — a use-case composes
 * repos, not other use-cases.
 */
export function createUserService(db: Db) {
  return {
    /** Creates a user (unique-email violations surface as EMAIL_TAKEN). */
    create(input: CreateUserInput): Promise<User> {
      return userRepo.createUser(db.rw, toWriteData(input));
    },

    /**
     * Returns the user with this email, creating one if none exists yet. Used
     * by non-GraphQL entry points like the OAuth callback, where a repeat
     * login must be idempotent.
     *
     * NOTE: a production app should link accounts by the provider's stable
     * account id (and confirm the email is verified), not by email alone.
     */
    findOrCreateByEmail(input: CreateUserInput): Promise<User> {
      return userRepo.upsertByEmail(db.rw, toWriteData(input));
    },

    /**
     * Transitions a user's status, enforcing the state machine in
     * user.state.ts. Read → decide → execute: the current status is read from
     * the primary, the core plans the move, and the write is a
     * compare-and-swap on the status the decision was made against — a
     * concurrent transition makes the CAS miss and throws a retryable
     * CONFLICT instead of persisting an illegal move. The returned user is the
     * row the CAS itself wrote (no unguarded re-read).
     */
    async changeStatus(id: number, to: UserStatus): Promise<User> {
      const current = await userRepo.getById(db.rw, id); // read
      const plan = planTransition(parseUserStatus(current.status), to); // decide
      if (plan.kind === 'noop') {
        return current;
      }
      const updated = await userRepo.transitionStatus(db.rw, id, plan.from, plan.to); // execute
      if (updated === null) {
        throw new ConcurrentUpdateError(`status of user ${id}`);
      }
      return updated;
    },
  };
}

export type UserService = ReturnType<typeof createUserService>;
