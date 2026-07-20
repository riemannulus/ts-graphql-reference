// Importing the builder first guarantees the root Query/Mutation types are
// established before the register calls below append fields to them.
import { builder } from './builder.js';

import { registerOnboardingModule } from '../modules/onboarding/schemas/index.js';
import { registerPointModule } from '../modules/point/schemas/index.js';
import { registerPostModule } from '../modules/post/schemas/index.js';
import { registerSearchModule } from '../modules/search/schemas/index.js';
import { registerUserModule } from '../modules/user/schemas/index.js';

// Explicit registration, not side-effect imports: each module contributes its
// whole GraphQL surface through ONE `registerXxxModule` function (defined in
// that module's schemas/index.ts), called exactly once, here. A module missing
// from this list is visibly absent (and its import is flagged as unused)
// instead of silently dropping out of the schema. Intra-module ordering (e.g.
// user types before user mutations) lives inside each module's register
// function; only cross-module order is decided here, and today none is
// required. The e2e schema snapshot test (src/tests/e2e/schema-snapshot.test.ts)
// guards the resulting SDL as a whole.
registerUserModule();
registerPostModule();
registerPointModule();
registerOnboardingModule();
registerSearchModule();

export const schema = builder.toSchema();
