import type { Prisma, User } from '@prisma/client';
import type { DbClient } from '../../db.js';
import type { UserStatus } from './user.state.js';
import type { Email } from './user.value.js';

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

export function createUser(db: DbClient, data: UserWriteData): Promise<User> {
  return db.user.create({ data });
}

/**
 * Returns the user with this email, creating one if none exists yet. `upsert`
 * keyed on the unique email makes that atomic — a repeat call is a no-op
 * rather than a unique-constraint failure.
 */
export function upsertByEmail(db: DbClient, data: UserWriteData): Promise<User> {
  return db.user.upsert({ where: { email: data.email }, update: {}, create: data });
}

/**
 * Compare-and-swap status transition: writes `to` only if the row still holds
 * `from` — the optimistic-concurrency guard for the service's read-then-decide
 * (see `changeStatus`). Returns whether the guarded write landed.
 */
export async function transitionStatus(
  db: DbClient,
  id: number,
  from: UserStatus,
  to: UserStatus,
): Promise<boolean> {
  const { count } = await db.user.updateMany({ where: { id, status: from }, data: { status: to } });
  return count === 1;
}
