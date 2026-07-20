import type { Prisma, User } from '@prisma/client';
import type { DbClient } from '../../db.js';
import { isRecordNotFound, isUniqueViolation } from '../../prisma-errors.js';
import type { UserStatus } from './user.state.js';
import { EmailAlreadyRegisteredError, type Email } from './user.value.js';

/**
 * User persistence — the only user-module file that talks Prisma.
 *
 * Read projections accept the Pothos `query` object and spread it (the
 * plugin's relation-loading optimization survives); `query` is Prisma-shaped,
 * so this layer is where it stops. Write functions take already-parsed domain
 * values (`Email`, `UserStatus`) — parsing happened at the boundary, in the
 * service. Which client a call runs on (rw / ro / a transaction) is always the
 * caller's choice, passed first.
 */

export interface UserWriteData {
  email: Email;
  name: string | null;
}

export function findById(
  db: DbClient,
  id: number,
  query: Prisma.UserDefaultArgs = {},
): Promise<User | null> {
  return db.user.findUnique({ ...query, where: { id } });
}

export function getById(
  db: DbClient,
  id: number,
  query: Prisma.UserDefaultArgs = {},
): Promise<User> {
  return db.user.findUniqueOrThrow({ ...query, where: { id } });
}

export function findMany(db: DbClient, query: Prisma.UserFindManyArgs = {}): Promise<User[]> {
  return db.user.findMany({ orderBy: { createdAt: 'desc' }, ...query });
}

export async function createUser(db: DbClient, data: UserWriteData): Promise<User> {
  try {
    return await db.user.create({ data });
  } catch (error) {
    // The unique-email violation is an expected domain outcome, not an
    // internal failure — translate it at the layer that knows Prisma.
    if (isUniqueViolation(error)) {
      throw new EmailAlreadyRegisteredError(data.email);
    }
    throw error;
  }
}

/**
 * Returns the user with this email, creating one if none exists yet, as ONE
 * atomic statement — safe against two concurrent first logins.
 *
 * The `update` branch intentionally writes the (unchanged) email: with an
 * empty `update: {}`, Prisma falls back to a non-atomic SELECT-then-INSERT
 * pair, and the loser of a concurrent first login dies on the unique
 * constraint. A non-empty update compiles to a native
 * `INSERT ... ON CONFLICT ("email") DO UPDATE`, which is atomic.
 */
export function upsertByEmail(db: DbClient, data: UserWriteData): Promise<User> {
  return db.user.upsert({
    where: { email: data.email },
    update: { email: data.email },
    create: data,
  });
}

/**
 * Compare-and-swap status transition: writes `to` only if the row still holds
 * `from` — the optimistic-concurrency guard for the service's read-then-decide
 * (see `changeStatus`). Returns the updated row, or null when the guard missed
 * (a concurrent transition won the race).
 */
export async function transitionStatus(
  db: DbClient,
  id: number,
  from: UserStatus,
  to: UserStatus,
): Promise<User | null> {
  try {
    // The non-unique `status` filter narrows the unique `id` — a guarded
    // single-row UPDATE that also returns the row it wrote.
    return await db.user.update({ where: { id, status: from }, data: { status: to } });
  } catch (error) {
    if (isRecordNotFound(error)) {
      return null;
    }
    throw error;
  }
}
