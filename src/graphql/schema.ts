// Importing the builder first guarantees the root Query/Mutation types are
// established before the register calls below append fields to them.
import { builder } from './builder.js';

import { registerOnboardingMutations } from '../modules/onboarding/schemas/onboarding.mutation.js';
import { registerPointMutations } from '../modules/point/schemas/point.mutation.js';
import { registerPointQueries } from '../modules/point/schemas/point.query.js';
import { registerPointTypes } from '../modules/point/schemas/point.type.js';
import { registerPostMutations } from '../modules/post/schemas/post.mutation.js';
import { registerPostQueries } from '../modules/post/schemas/post.query.js';
import { registerPostTypes } from '../modules/post/schemas/post.type.js';
import { registerPostSearchQueries } from '../modules/search/schemas/post-search.query.js';
import { registerUserMutations } from '../modules/user/schemas/user.mutation.js';
import { registerUserQueries } from '../modules/user/schemas/user.query.js';
import { registerUserTypes } from '../modules/user/schemas/user.type.js';

// Explicit registration, not side-effect imports: each module contributes its
// types/queries/mutations through a named register function called exactly
// once, here. A module missing from this list is visibly absent (and its
// import is flagged as unused) instead of silently dropping out of the schema.
// The e2e schema snapshot test (src/tests/e2e/schema-snapshot.test.ts) guards
// the resulting SDL as a whole.
registerUserTypes();
registerUserQueries();
registerUserMutations();
registerPostTypes();
registerPostQueries();
registerPostMutations();
registerPointTypes();
registerPointQueries();
registerPointMutations();
registerOnboardingMutations();
registerPostSearchQueries();

export const schema = builder.toSchema();
