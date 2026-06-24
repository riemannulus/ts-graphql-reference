import type { Prisma, PrismaClient, User } from '@prisma/client';
import { assertTransition, isUserStatus, type UserStatus } from './user.state.js';
import { parseEmail } from './user.value.js';

export interface CreateUserInput {
  email: string;
  name?: string | null;
}

/**
 * Business logic for users. Receives the PrismaClient via constructor injection
 * (see app.ts) so it can be unit-tested with a throwaway database.
 *
 * Read methods accept the Pothos `query` object (`select`/`include`) and spread
 * it into the Prisma call, so the prisma plugin's relation-loading optimization
 * is preserved even though queries go through the service layer.
 */
export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: number, query: Prisma.UserDefaultArgs = {}): Promise<User | null> {
    return this.prisma.user.findUnique({ ...query, where: { id } });
  }

  findMany(query: Prisma.UserFindManyArgs = {}): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' }, ...query });
  }

  create(
    input: CreateUserInput,
    query: Prisma.UserDefaultArgs = {},
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<User> {
    // Parse at the boundary: an invalid email never reaches the database.
    const email = parseEmail(input.email);
    return client.user.create({
      ...query,
      data: { email, name: input.name ?? null },
    });
  }

  /**
   * Returns the user with this email, creating one if none exists yet.
   *
   * Used by non-GraphQL entry points like the OAuth callback, where a repeat
   * login must be idempotent rather than fail on the unique-email constraint.
   * `upsert` keyed on the unique email makes that atomic — a new account is
   * created on first login (the `create` branch) and reused as a no-op
   * afterwards. Email is parsed at the boundary, exactly like `create`.
   *
   * NOTE: a production app should link accounts by the provider's stable
   * account id (and confirm the email is verified), not by email alone.
   */
  findOrCreateByEmail(input: CreateUserInput, query: Prisma.UserDefaultArgs = {}): Promise<User> {
    const email = parseEmail(input.email);
    return this.prisma.user.upsert({
      ...query,
      where: { email },
      update: {},
      create: { email, name: input.name ?? null },
    });
  }

  /**
   * Transitions a user's status, enforcing the state-machine invariant in
   * user.state.ts. Throws InvalidStatusTransitionError on an illegal move.
   */
  async changeStatus(
    id: number,
    to: UserStatus,
    query: Prisma.UserDefaultArgs = {},
  ): Promise<User> {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    const from: UserStatus = isUserStatus(current.status) ? current.status : 'ACTIVE';
    assertTransition(from, to);
    return this.prisma.user.update({ ...query, where: { id }, data: { status: to } });
  }
}
