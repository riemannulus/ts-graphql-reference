import { builder } from '../../../builder.js';
import * as pointRepo from '../point.repo.js';

/**
 * Query path: resolvers call repo read projections directly on the routed
 * selection client (`ctx.prisma` — the replica for query operations). No
 * service in between: plain reads carry no decisions, so the use-case layer
 * would only add a pass-through.
 */
export function registerPointQueries(): void {
  builder.queryField('pointBalance', (t) =>
    t.prismaField({
      type: 'PointBalance',
      nullable: true,
      description: "A user's current point balance (null until the first charge).",
      args: { userId: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => pointRepo.findBalance(ctx.prisma, args.userId, query),
    }),
  );

  builder.queryField('pointCharges', (t) =>
    t.prismaField({
      type: ['PointCharge'],
      description: "A user's point charges in spend (FIFO) order.",
      args: { userId: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => pointRepo.findCharges(ctx.prisma, args.userId, query),
    }),
  );

  builder.queryField('pointSpends', (t) =>
    t.prismaField({
      type: ['PointSpend'],
      description: "A user's point spends, most recent first.",
      args: { userId: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) => pointRepo.findSpends(ctx.prisma, args.userId, query),
    }),
  );
}
