import { builder } from '../../../graphql/builder.js';
import * as userRepo from '../user.repo.js';

/** Query path: repo read projections on the routed selection client. */
export function registerUserQueries(): void {
  builder.queryField('user', (t) =>
    t.prismaField({
      type: 'User',
      nullable: true,
      args: { id: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => userRepo.findById(ctx.read, args.id, query),
    }),
  );

  builder.queryField('users', (t) =>
    t.prismaField({
      type: ['User'],
      resolve: (query, _root, _args, ctx) => userRepo.findMany(ctx.read, query),
    }),
  );
}
