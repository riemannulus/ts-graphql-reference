import { builder } from '../../../graphql/builder.js';
import { writer } from '../../../graphql/context.js';
import * as postRepo from '../post.repo.js';

/**
 * Tier-1 writes: with no decisions to make, mutations call repo write
 * functions directly — and since those functions accept the Pothos `query`,
 * no re-fetch is needed (the write itself returns the selection). Compare the
 * point module, where writes go through a use-case that never sees `query`
 * and the resolver re-fetches.
 *
 * The write client comes from `writer(ctx)`: `ctx.db` is read-only by type, so
 * `writer` is the explicit (and runtime-guarded) widening to a `DbClient` — it
 * both satisfies the repo's write signature and marks "this is a tier-1 direct
 * write" at the call site.
 */
export function registerPostMutations(): void {
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
        postRepo.createPost(
          writer(ctx),
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
      resolve: (query, _root, args, ctx) => postRepo.publishPost(writer(ctx), args.id, query),
    }),
  );
}
