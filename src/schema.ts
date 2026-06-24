// Importing the builder first guarantees the root Query/Mutation types are
// established before the module files below append fields to them.
import { builder } from './builder.js';

// Each import registers that module's types/queries/mutations on the shared
// builder via side effects. Add new modules here.
import './modules/user/user.schema.js';
import './modules/post/schemas/post.type.js';
import './modules/post/schemas/post.query.js';
import './modules/post/schemas/post.mutation.js';
import './modules/onboarding/schemas/onboarding.mutation.js';

export const schema = builder.toSchema();
