import { builder } from '../../../graphql/builder.js';
import * as ledgerRepo from '../ledger.read.repo.js';
import { CURRENCIES, userHolder } from '../ledger.value.js';

/**
 * Query path: resolvers call repo read projections directly on the routed
 * selection client (the replica, for a query operation). No service in between
 * — plain reads carry no decisions, so the use-case layer would only add a
 * pass-through.
 *
 * The arguments are USER ids rather than holder keys. A holder key is an
 * internal name the kernel computes; making clients spell `USER:7` would leak
 * the naming rule into every caller and, worse, let one ask about an escrow that
 * belongs to someone else's order.
 *
 * These fields take the user id as an ARGUMENT and are ungated, like every other
 * query in this reference (there is no authorization layer yet — README). In a
 * real deployment a person's own financial history is the last thing that may be
 * read by id: each of these becomes a field on the viewer, resolved from the
 * session, and the by-id form survives only behind a staff gate.
 */
export function registerLedgerQueries(): void {
  const CurrencyArgEnum = builder.enumType('LedgerCurrencyFilter', {
    values: CURRENCIES,
    description: 'Which currency to list lots for.',
  });

  builder.queryField('ledgerBalances', (t) =>
    t.prismaField({
      type: ['LedgerBalance'],
      description: "A person's balances, one row per currency they have ever held.",
      args: { userId: t.arg.int({ required: true }) },
      resolve: (query, _root, args, ctx) =>
        ledgerRepo.findBalances(ctx.db, userHolder(args.userId), query),
    }),
  );

  builder.queryField('ledgerLotHoldings', (t) =>
    t.prismaField({
      type: ['LedgerLotBalance'],
      description:
        "A person's live lots of one currency, in the order they will be spent " +
        `(earliest deadline first). At most ${ledgerRepo.LOT_PAGE_SIZE}: the ` +
        'first page is the one that will be spent.',
      args: {
        userId: t.arg.int({ required: true }),
        currency: t.arg({ type: CurrencyArgEnum, required: true }),
      },
      resolve: (query, _root, args, ctx) =>
        ledgerRepo.findLotHoldings(ctx.db, userHolder(args.userId), args.currency, query),
    }),
  );

  builder.queryField('ledgerReference', (t) =>
    t.prismaField({
      type: 'LedgerReference',
      nullable: true,
      description: 'One money flow by the id a person can quote.',
      args: { id: t.arg.string({ required: true }) },
      resolve: (query, _root, args, ctx) => ledgerRepo.findReference(ctx.db, args.id, query),
    }),
  );

  builder.queryField('ledgerReferenceEvents', (t) =>
    t.prismaField({
      type: ['LedgerEvent'],
      description:
        "A flow's movements, in the order they happened. At most " +
        `${ledgerRepo.EVENT_PAGE_SIZE} at a time: pass the \`seq\` of the last ` +
        'row you have as `after` for the next page.',
      args: {
        referenceId: t.arg.string({ required: true }),
        after: t.arg.int({ required: false }),
      },
      resolve: (query, _root, args, ctx) =>
        ledgerRepo.findReferenceEvents(ctx.db, args.referenceId, args.after ?? null, query),
    }),
  );

  builder.queryField('ledgerHolderEvents', (t) =>
    t.prismaField({
      type: ['LedgerEvent'],
      description:
        "A person's movements across every currency, most recent first — a " +
        'settlement burns points and mints income, and a statement that showed ' +
        `only one of them would not add up. At most ${ledgerRepo.EVENT_PAGE_SIZE} ` +
        'at a time: pass the `seq` of the oldest row you have as `before` for ' +
        'the next page.',
      args: {
        userId: t.arg.int({ required: true }),
        before: t.arg.int({ required: false }),
      },
      resolve: (query, _root, args, ctx) =>
        ledgerRepo.findHolderEvents(ctx.db, userHolder(args.userId), args.before ?? null, query),
    }),
  );
}
