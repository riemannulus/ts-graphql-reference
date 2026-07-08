import { builder } from '../../../builder.js';
import * as pointRepo from '../point.repo.js';

/**
 * Mutation path: the write goes through the use-case (which never sees the
 * GraphQL selection), then the resolver RE-FETCHES the result by id with the
 * Pothos `query` so the client's selection set — including relations — is
 * loaded optimally. `ctx.prisma` is the PRIMARY during mutations (see
 * selectSelectionClient), so the re-fetch reads-its-own-write even when a
 * replica is configured.
 */
export function registerPointMutations(): void {
  const ChargePointInput = builder.inputType('ChargePointInput', {
    fields: (t) => ({
      userId: t.int({ required: true }),
      paidAmount: t.int({ required: true }),
      freeAmount: t.int({ required: true }),
    }),
  });

  const SpendPointInput = builder.inputType('SpendPointInput', {
    fields: (t) => ({
      userId: t.int({ required: true }),
      amount: t.int({ required: true }),
      reason: t.string({ required: true }),
    }),
  });

  builder.mutationField('chargePoint', (t) =>
    t.prismaField({
      type: 'PointCharge',
      description: 'Tops up a user with paid and/or free points.',
      args: { input: t.arg({ type: ChargePointInput, required: true }) },
      resolve: async (query, _root, args, ctx) => {
        const charge = await ctx.services.point.charge(args.input.userId, {
          paidAmount: args.input.paidAmount,
          freeAmount: args.input.freeAmount,
        });
        return pointRepo.getChargeById(ctx.prisma, charge.id, query);
      },
    }),
  );

  builder.mutationField('spendPoint', (t) =>
    t.prismaField({
      type: 'PointSpend',
      description: 'Spends points, paid balance first, FIFO across charges.',
      args: { input: t.arg({ type: SpendPointInput, required: true }) },
      resolve: async (query, _root, args, ctx) => {
        const spend = await ctx.services.point.spend(args.input.userId, {
          amount: args.input.amount,
          reason: args.input.reason,
        });
        return pointRepo.getSpendById(ctx.prisma, spend.id, query);
      },
    }),
  );
}
