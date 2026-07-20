import { builder } from '../../../graphql/builder.js';
import * as userRepo from '../user.repo.js';
import { UserStatusEnum } from './user.type.js';

/**
 * Mutation path: the use-case decides and writes; the resolver re-fetches with
 * the Pothos `query` (on the primary — ctx.prisma routes mutations to rw) so the
 * selection set is loaded optimally and reads-its-own-write. The `status` arg
 * reuses the `UserStatusEnum` registered by `registerUserTypes` (called first in
 * schema.ts).
 */
export function registerUserMutations(): void {
  builder.mutationField('changeUserStatus', (t) =>
    t.prismaField({
      type: 'User',
      args: {
        id: t.arg.int({ required: true }),
        status: t.arg({ type: UserStatusEnum, required: true }),
      },
      resolve: async (query, _root, args, ctx) => {
        const user = await ctx.services.user.changeStatus(args.id, args.status);
        return userRepo.getById(ctx.prisma, user.id, query);
      },
    }),
  );
}
