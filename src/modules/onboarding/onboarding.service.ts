import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { PostService } from '../post/post.service.js';
import type { CreateUserInput, UserService } from '../user/user.service.js';
import { buildWelcomePost } from './onboarding.content.js';

interface OnboardingServiceDeps {
  users: UserService;
  posts: PostService;
  prisma: PrismaClient;
}

/**
 * Orchestrates sign-up across the user and post modules. This module depends on
 * UserService and PostService, never the other way round — the same one-way
 * shape as OAuthService → UserService (see context.ts).
 */
export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  /**
   * Creates a user and their default welcome post in a single interactive
   * transaction: if the welcome post fails, the user is rolled back too.
   *
   * Returns the created user; a `signUp { posts { ... } }` selection sees the
   * welcome post because Pothos resolves the relation after the transaction
   * commits.
   */
  register(input: CreateUserInput, _query: Prisma.UserDefaultArgs = {}): Promise<User> {
    return this.deps.prisma.$transaction(async (tx) => {
      const user = await this.deps.users.create(input, {}, tx);
      const { title, content } = buildWelcomePost(user);
      await this.deps.posts.create({ authorId: user.id, title, content }, {}, tx);
      return user;
    });
  }
}
