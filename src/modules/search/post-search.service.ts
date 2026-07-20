import type { PostSearchIndex, PostSearchResult } from './post-search.provider.js';

export interface PostSearchServiceDeps {
  index: PostSearchIndex;
}

/**
 * The post-search use-case. It is intentionally THIN — search carries no domain
 * decision yet (no state machine, no computed plan), so it has no core. It still
 * earns a service for the same reason auth does: the external `PostSearchIndex`
 * port needs a home in the service container and a seam tests inject a fake at.
 * It returns domain data (`{ total, ids }`) and never learns about GraphQL — the
 * schema layer maps the selection and hydrates the ids.
 *
 * It graduates a `*.core.ts` the day search grows a real rule (a filter policy,
 * ranking weights, a blank-term short-circuit).
 */
export function createPostSearchService(deps: PostSearchServiceDeps) {
  return {
    search(term: string, options: { limit: number }): Promise<PostSearchResult> {
      return deps.index.search(term, options);
    },
  };
}

export type PostSearchService = ReturnType<typeof createPostSearchService>;
