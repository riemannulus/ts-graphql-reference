import { builder } from '../../../graphql/builder.js';
import { parseUserStatus, USER_STATUSES } from '../user.state.js';

const defineUserStatusEnum = () =>
  builder.enumType('UserStatus', {
    values: USER_STATUSES,
    description: 'Lifecycle state of a user.',
  });

/**
 * The `UserStatus` enum ref, shared with the mutation file (the
 * `changeUserStatus` `status` arg). Assigned when `registerUserTypes` runs;
 * because `schema.ts` registers types before mutations, it is defined by the
 * time `registerUserMutations` reads it.
 *
 * This is a module-scoped ref, NOT an import-time side effect — the enum is
 * registered only inside the register function. A named type used by more than
 * one of a module's schema files (here an enum shared by an output field and an
 * input arg) is exactly what the `.type.ts` file owns and exports; `point/`
 * needs none because its enum is used only within its own type.
 */
export let UserStatusEnum: ReturnType<typeof defineUserStatusEnum>;

export function registerUserTypes(): void {
  UserStatusEnum = defineUserStatusEnum();

  builder.prismaObject('User', {
    fields: (t) => ({
      id: t.exposeID('id'),
      email: t.exposeString('email'),
      name: t.exposeString('name', { nullable: true }),
      status: t.field({
        type: UserStatusEnum,
        // Parse, don't cast: an out-of-set DB value throws (masked) instead of
        // silently passing through the API.
        resolve: (user) => parseUserStatus(user.status),
      }),
      createdAt: t.string({ resolve: (user) => user.createdAt.toISOString() }),
      // Relations resolved efficiently by the Pothos Prisma plugin.
      posts: t.relation('posts'),
      pointBalance: t.relation('pointBalance', { nullable: true }),
    }),
  });
}
