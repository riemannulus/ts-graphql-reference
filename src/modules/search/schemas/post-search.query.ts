import { builder } from '../../../graphql/builder.js';
import * as postRepo from '../../post/post.repo.js';

/**
 * A search resolver where the ids come from OUTSIDE the database (the search
 * index port) and the Post selection is nested under a wrapper type, so the
 * root resolver is never handed a Post `query`. Rather than building one by
 * hand at the root, the wrapper field that OWNS the Post selection is itself
 * a `t.prismaField` — Pothos hands it a `query`, created exactly where it is
 * consumed. The three steps:
 *
 *   1. the root resolver calls the index and returns domain data only
 *      (ranked ids + total) — it never touches a `query`;
 *   2. Pothos gives the `hits` prismaField the Prisma-shaped `query` for the
 *      selection under it, the same object a root prismaField receives — and
 *      it still STOPS at the repo (services never see it);
 *   3. `postRepo.findByIds` hydrates on `ctx.db`, preserving the index's rank
 *      order. A client selecting only `total` skips hydration entirely.
 *
 * When a field CANNOT be a prismaField — its type is a union of several
 * models (a `...Response` payload, a mixed feed) — build the per-member
 * query by hand with `queryFromInfo({ path })` instead (see CONVENTIONS.md
 * "Where GraphQL meets the database").
 */
interface PostSearchPage {
  total: number;
  ids: number[];
}

export function registerPostSearchQueries(): void {
  const SearchPostsResult = builder.objectRef<PostSearchPage>('SearchPostsResult');
  SearchPostsResult.implement({
    description: 'A page of posts matching a search term, plus the total match count.',
    fields: (t) => ({
      total: t.exposeInt('total', { description: 'Total posts matching the term.' }),
      hits: t.prismaField({
        type: ['Post'],
        description: "The matching posts, in the index's rank order.",
        resolve: (query, page, _args, ctx) => postRepo.findByIds(ctx.db, page.ids, query),
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
      resolve: async (_root, args, ctx) => {
        const { total, ids } = await ctx.services.postSearch.search(args.term, {
          limit: args.limit ?? 10,
        });
        return { total, ids };
      },
    }),
  );
}
