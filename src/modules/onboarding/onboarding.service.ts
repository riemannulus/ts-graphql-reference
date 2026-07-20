import type { User } from '@prisma/client';
import type { Db } from '../../db.js';
import { uow } from '../../uow.js';
import * as postRepo from '../post/post.repo.js';
import type { CreateUserInput } from '../user/user.service.js';
import * as userRepo from '../user/user.repo.js';
import { parseEmail } from '../user/user.value.js';
import { buildWelcomePost } from './onboarding.content.js';

export interface OnboardingServiceDeps {
  db: Db;
  /**
   * The welcome-post writer, injectable so tests can force the second write to
   * fail and observe the rollback. Defaults to the real post repo function.
   */
  createPost?: typeof postRepo.createPost;
}

/**
 * Orchestrates sign-up across the user and post modules — the reference's
 * example of a CROSS-MODULE use-case. Because both writes must commit or roll
 * back together, it opens ONE transaction and composes the two modules' repo
 * write functions inside it; decisions still come from the owning modules'
 * cores (`parseEmail` from user, `buildWelcomePost` from onboarding). This
 * module depends on user/post, never the other way round.
 */
export function createOnboardingService(deps: OnboardingServiceDeps) {
  const createPost = deps.createPost ?? postRepo.createPost;
  return {
    /**
     * Creates a user and their default welcome post atomically: if the welcome
     * post fails, the user is rolled back too.
     */
    register(input: CreateUserInput): Promise<User> {
      const email = parseEmail(input.email); // decide (parse at the boundary)
      return uow.run(deps.db, async (tx) => {
        const user = await userRepo.createUser(tx, { email, name: input.name ?? null });
        const { title, content } = buildWelcomePost(user); // decide
        await createPost(tx, { authorId: user.id, title, content });
        return user;
      });
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
