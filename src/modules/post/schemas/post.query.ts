import { builder } from '../../../builder.js';

builder.queryField('post', (t) =>
  t.prismaField({
    type: 'Post',
    nullable: true,
    args: { id: t.arg.int({ required: true }) },
    resolve: (query, _root, args, ctx) => ctx.services.post.findById(args.id, query),
  }),
);

builder.queryField('posts', (t) =>
  t.prismaField({
    type: ['Post'],
    args: { onlyPublished: t.arg.boolean({ required: false }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.post.findMany(query, { onlyPublished: args.onlyPublished ?? false }),
  }),
);
