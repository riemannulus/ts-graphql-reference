import type { User } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { uow } from '../../db/uow.js';
import type { FlagReader } from '../../flags/flag-registry.js';
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
     * Creates a user and their welcome post atomically: if the welcome post fails,
     * the user is rolled back too. The welcome copy is an "implementation swap"
     * flag (mode 3): the `welcomeVariant` value is read here (as data, before the
     * transaction) and handed to the core, which selects the builder from an
     * exhaustive record — the selection stays in the core, not the shell.
     */
    // `async` so `parseEmail`'s synchronous rejection surfaces as a rejected promise.
    async register(input: CreateUserInput, flags: FlagReader): Promise<User> {
      const email = parseEmail(input.email); // decide (parse at the boundary)
      const variant = await flags.welcomeVariant(); // read the flag as data
      return uow.run(deps.db, async (tx) => {
        const user = await userRepo.createUser(tx, { email, name: input.name ?? null });
        const { title, content } = buildWelcomePost(user, variant); // decide
        await createPost(tx, { authorId: user.id, title, content });
        return user;
      });
    },
  };
}

export type OnboardingService = ReturnType<typeof createOnboardingService>;
