import { builder } from '../../graphql/builder.js';
import * as userRepo from './user.repo.js';
import { parseUserStatus, USER_STATUSES } from './user.state.js';

export function registerUserSchema(): void {
  const UserStatusEnum = builder.enumType('UserStatus', {
    values: USER_STATUSES,
    description: 'Lifecycle state of a user.',
  });

  builder.prismaObject('User', {
    fields: (t) => ({
      id: t.exposeID('id'),
      email: t.exposeString('email'),
      name: t.exposeString('name', { nullable: true }),
      status: t.field({
        type: UserStatusEnum,
        // Parse, don't cast: an out-of-set DB value throws (masked) instead of
        // silently passing through the API.
        resolve: (user) => parseUserStatus(user.status),
      }),
      createdAt: t.string({ resolve: (user) => user.createdAt.toISOString() }),
      // Relations resolved efficiently by the Pothos Prisma plugin.
      posts: t.relation('posts'),
      pointBalance: t.relation('pointBalance', { nullable: true }),
    }),
  });

  // Query path: repo read projections on the routed selection client.
  builder.queryField('user', (t) =>
    t.prismaField({
      type: 'User',
      nullable: true,
      args: { id: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => userRepo.findById(ctx.prisma, args.id, query),
    }),
  );

  builder.queryField('users', (t) =>
    t.prismaField({
      type: ['User'],
      resolve: (query, _root, _args, ctx) => userRepo.findMany(ctx.prisma, query),
    }),
  );

  // Mutation path: the use-case decides and writes; the resolver re-fetches
  // with the Pothos `query` (on the primary — ctx.prisma routes mutations to
  // rw) so the selection set is loaded optimally and reads-its-own-write.
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
