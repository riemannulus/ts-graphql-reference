import { builder } from '../../../builder.js';

const CreatePostInput = builder.inputType('CreatePostInput', {
  fields: (t) => ({
    title: t.string({ required: true }),
    content: t.string({ required: false }),
    authorId: t.int({ required: true }),
  }),
});

builder.mutationField('createPost', (t) =>
  t.prismaField({
    type: 'Post',
    args: { input: t.arg({ type: CreatePostInput, required: true }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.post.create(
        {
          title: args.input.title,
          content: args.input.content,
          authorId: args.input.authorId,
        },
        query,
      ),
  }),
);

builder.mutationField('publishPost', (t) =>
  t.prismaField({
    type: 'Post',
    args: { id: t.arg.int({ required: true }) },
    resolve: (query, _root, args, ctx) => ctx.services.post.publish(args.id, query),
  }),
);
