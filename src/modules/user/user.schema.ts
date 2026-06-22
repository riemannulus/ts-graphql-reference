import { builder } from '../../builder.js';
import { USER_STATUSES, type UserStatus } from './user.state.js';

const UserStatusEnum = builder.enumType('UserStatus', {
  values: USER_STATUSES,
  description: 'Lifecycle state of a user.',
});

export const UserType = builder.prismaObject('User', {
  fields: (t) => ({
    id: t.exposeID('id'),
    email: t.exposeString('email'),
    name: t.exposeString('name', { nullable: true }),
    status: t.field({
      type: UserStatusEnum,
      resolve: (user) => user.status as UserStatus,
    }),
    createdAt: t.string({ resolve: (user) => user.createdAt.toISOString() }),
    // Relation resolved efficiently by the Pothos Prisma plugin.
    posts: t.relation('posts'),
  }),
});

builder.queryField('user', (t) =>
  t.prismaField({
    type: 'User',
    nullable: true,
    args: { id: t.arg.int({ required: true }) },
    resolve: (query, _root, args, ctx) => ctx.services.user.findById(args.id, query),
  }),
);

builder.queryField('users', (t) =>
  t.prismaField({
    type: ['User'],
    resolve: (query, _root, _args, ctx) => ctx.services.user.findMany(query),
  }),
);

const CreateUserInput = builder.inputType('CreateUserInput', {
  fields: (t) => ({
    email: t.string({ required: true }),
    name: t.string({ required: false }),
  }),
});

builder.mutationField('createUser', (t) =>
  t.prismaField({
    type: 'User',
    args: { input: t.arg({ type: CreateUserInput, required: true }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.user.create({ email: args.input.email, name: args.input.name }, query),
  }),
);

builder.mutationField('changeUserStatus', (t) =>
  t.prismaField({
    type: 'User',
    args: {
      id: t.arg.int({ required: true }),
      status: t.arg({ type: UserStatusEnum, required: true }),
    },
    resolve: (query, _root, args, ctx) =>
      ctx.services.user.changeStatus(args.id, args.status, query),
  }),
);
