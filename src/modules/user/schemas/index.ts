import { registerUserMutations } from './user.mutation.js';
import { registerUserQueries } from './user.query.js';
import { registerUserTypes } from './user.type.js';

/**
 * The user module's GraphQL surface, registered as one unit. Types come before
 * mutations on purpose: user.mutation.ts uses `UserStatusEnum`, which
 * registerUserTypes() assigns. That intra-module ordering now lives here, in
 * the module that owns it, instead of riding on the line order of schema.ts.
 *
 * This is a COMPOSITION point, not a barrel: it calls the register functions,
 * it does not re-export the module's services/repos — so the file-name lint
 * globs that enforce the layering stay intact.
 */
export function registerUserModule(): void {
  registerUserTypes();
  registerUserQueries();
  registerUserMutations();
}
