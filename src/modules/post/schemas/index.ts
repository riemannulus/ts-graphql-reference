import { registerPostMutations } from './post.mutation.js';
import { registerPostQueries } from './post.query.js';
import { registerPostTypes } from './post.type.js';

/**
 * The post module's GraphQL surface, registered as one unit. A composition
 * point, not a barrel: it calls the register functions, it does not re-export
 * the module's repo — so the file-name lint globs that enforce the layering
 * stay intact.
 */
export function registerPostModule(): void {
  registerPostTypes();
  registerPostQueries();
  registerPostMutations();
}
