import { registerPointMutations } from './point.mutation.js';
import { registerPointQueries } from './point.query.js';
import { registerPointSubscriptions } from './point.subscription.js';
import { registerPointTypes } from './point.type.js';

/**
 * The point module's GraphQL surface, registered as one unit. A composition
 * point, not a barrel: it calls the register functions, it does not re-export
 * the module's core/repo/service — so the file-name lint globs that enforce
 * the layering stay intact.
 */
export function registerPointModule(): void {
  registerPointTypes();
  registerPointQueries();
  registerPointMutations();
  registerPointSubscriptions();
}
