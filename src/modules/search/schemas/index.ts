import { registerPostSearchQueries } from './post-search.query.js';

/**
 * The search module's GraphQL surface, registered as one unit. Only one
 * register function today, but it wears the same `registerXxxModule` shape so
 * schema.ts knows exactly one entry point per module — no special case.
 */
export function registerSearchModule(): void {
  registerPostSearchQueries();
}
