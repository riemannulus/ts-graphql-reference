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

  create(input: CreateUserInput, query: Prisma.UserDefaultArgs = {}): Promise<User> {
    // Parse at the boundary: an invalid email never reaches the database.
    const email = parseEmail(input.email);
    return this.prisma.user.create({
      ...query,
      data: { email, name: input.name ?? null },
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
