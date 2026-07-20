import { builder } from '../../../graphql/builder.js';
import * as userRepo from '../../user/user.repo.js';

export function registerOnboardingMutations(): void {
  const SignUpInput = builder.inputType('SignUpInput', {
    fields: (t) => ({
      email: t.string({ required: true }),
      name: t.string({ required: false }),
    }),
  });

  builder.mutationField('signUp', (t) =>
    t.prismaField({
      type: 'User',
      args: { input: t.arg({ type: SignUpInput, required: true }) },
      resolve: async (query, _root, args, ctx) => {
        const user = await ctx.services.onboarding.register({
          email: args.input.email,
          name: args.input.name,
        });
        // Re-fetch with the selection AFTER the use-case's transaction
        // committed (on the primary — mutations route to rw), so a
        // `signUp { posts { ... } }` selection sees the welcome post.
        return userRepo.getById(ctx.read, user.id, query);
      },
    }),
  );
}
