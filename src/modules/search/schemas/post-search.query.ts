import { getRefFromModel, queryFromInfo } from '@pothos/plugin-prisma';
import type { Post } from '@prisma/client';
import { builder } from '../../../graphql/builder.js';
import * as postRepo from '../../post/post.repo.js';

/**
 * A search resolver where the ids come from OUTSIDE the database (the search
 * index port) and the Post selection is nested under a wrapper type, so the
 * Pothos Prisma plugin cannot hand the resolver a `query` the way
 * `t.prismaField` does. The three steps:
 *
 *   1. the service calls the index and returns ranked ids (domain data);
 *   2. `queryFromInfo({ path: ['hits'] })` translates the GraphQL selection under
 *      the wrapper's `hits` field into the same Prisma-shaped `query` a
 *      prismaField would receive — this is the one place the schema layer builds
 *      a `query` by hand, and it still STOPS at the repo (services never see it);
 *   3. `postRepo.findByIds` hydrates on `ctx.db`, preserving the index's rank
 *      order. The same `queryFromInfo({ path })` handles a payload/union wrapper
 *      too (e.g. a `...Response` mutation result), not just search.
 */
interface PostSearchPage {
  total: number;
  hits: Post[];
}

export function registerPostSearchQueries(): void {
  const SearchPostsResult = builder.objectRef<PostSearchPage>('SearchPostsResult');
  SearchPostsResult.implement({
    description: 'A page of posts matching a search term, plus the total match count.',
    fields: (t) => ({
      total: t.exposeInt('total', { description: 'Total posts matching the term.' }),
      hits: t.field({
        // A prisma object's string ref (`'Post'`) is only usable in prismaField;
        // on a plain object field, take the model's ref explicitly.
        type: [getRefFromModel('Post', builder)],
        description: "The matching posts, in the index's rank order.",
        resolve: (page) => page.hits,
      }),
    }),
  });

  builder.queryField('searchPosts', (t) =>
    t.field({
      type: SearchPostsResult,
      description: 'Full-text search over posts, hydrated from the primary/replica by id.',
      args: {
        term: t.arg.string({ required: true }),
        limit: t.arg.int({ required: false }),
      },
      resolve: async (_root, args, ctx, info) => {
        const { total, ids } = await ctx.services.postSearch.search(args.term, {
          limit: args.limit ?? 10,
        });
        // The Post selection lives under `hits`, so build its query by hand.
        const query = queryFromInfo({ context: ctx, info, path: ['hits'], typeName: 'Post' });
        const hits = await postRepo.findByIds(ctx.db, ids, query);
        return { total, hits };
      },
    }),
  );
}
