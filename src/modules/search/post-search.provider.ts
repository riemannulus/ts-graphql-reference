/**
 * Port for an external post search index (Elasticsearch, etc.) — a record of
 * functions, not a class, exactly like the OAuth provider. The search service
 * depends on this shape, never on a concrete client, so production can leave it
 * unimplemented and tests inject a fake in-memory index.
 *
 * The index is the source of truth for MATCHING and RANKING; it returns ids
 * (and a total), never rows. Hydrating those ids into Post rows is the
 * database's job (see `post.repo.findByIds`), which is why this port is
 * deliberately Prisma-free.
 */

/** What one search returns: the total match count and the ranked post ids (best first). */
export interface PostSearchResult {
  total: number;
  ids: number[];
}

export interface PostSearchIndex {
  /** Query the index; returns the total and the ranked post ids. */
  search(term: string, options: { limit: number }): Promise<PostSearchResult>;
}

/**
 * Production binding — intentionally left UNIMPLEMENTED, like the OAuth stub.
 * Wiring it up means pointing `search` at your Elasticsearch/OpenSearch client;
 * everything around it (the service seam, the `hits` prismaField's selection
 * mapping, and order-preserving hydration) is complete and tested with a fake
 * index.
 */
export const stubPostSearchIndex: PostSearchIndex = {
  search() {
    return Promise.reject(
      new Error('PostSearchIndex.search not implemented: configure the search backend'),
    );
  },
};
