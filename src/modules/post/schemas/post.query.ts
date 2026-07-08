import { builder } from '../../../builder.js';
import * as postRepo from '../post.repo.js';

export function registerPostQueries(): void {
  builder.queryField('post', (t) =>
    t.prismaField({
      type: 'Post',
      nullable: true,
      args: { id: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => postRepo.findById(ctx.prisma, args.id, query),
    }),
  );

  builder.queryField('posts', (t) =>
    t.prismaField({
      type: ['Post'],
      args: { onlyPublished: t.arg.boolean({ required: false }) },
      resolve: (query, _root, args, ctx) =>
        postRepo.findMany(ctx.prisma, query, { onlyPublished: args.onlyPublished ?? false }),
    }),
  );
}
