import { builder } from '../../../builder.js';

const SignUpInput = builder.inputType('SignUpInput', {
  fields: (t) => ({
    email: t.string({ required: true }),
    name: t.string({ required: false }),
  }),
});

builder.mutationField('signUp', (t) =>
  t.prismaField({
    type: 'User',
    args: { input: t.arg({ type: SignUpInput, required: true }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.onboarding.register(
        { email: args.input.email, name: args.input.name },
        query,
      ),
  }),
);
