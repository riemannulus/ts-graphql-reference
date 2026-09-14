import { builder } from '../../../graphql/builder.js';
import type { IncomeWithdrawalResult } from '../income-withdrawal.core.js';

export function registerIncomeWithdrawalMutations(): void {
  const InputRef = builder.inputType('IncomeWithdrawalInput', {
    fields: (t) => ({
      actorId: t.int({ required: true }),
      amount: t.int({ required: true }),
      commandKey: t.string({ required: true }),
    }),
  });
  const SourceRef = builder.objectRef<IncomeWithdrawalResult['sources'][number]>(
    'IncomeWithdrawalSource',
  );
  SourceRef.implement({
    fields: (t) => ({
      commissionReferenceId: t.exposeString('commissionReferenceId'),
      amount: t.exposeInt('amount'),
    }),
  });
  const ResultRef = builder.objectRef<IncomeWithdrawalResult>('IncomeWithdrawalResult');
  ResultRef.implement({
    description: 'PROTOTYPE result of reserving withdrawable INCOME.',
    fields: (t) => ({
      withdrawalId: t.exposeString('withdrawalId'),
      reservationId: t.exposeInt('reservationId'),
      referenceId: t.exposeString('referenceId'),
      commandId: t.exposeString('commandId'),
      operationId: t.exposeString('operationId'),
      replayed: t.exposeBoolean('replayed'),
      sources: t.field({ type: [SourceRef], resolve: (result) => result.sources }),
    }),
  });
  builder.mutationField('requestIncomeWithdrawal', (t) =>
    t.field({
      type: ResultRef,
      description: 'PROTOTYPE: reserves FIFO INCOME lots under a WITHDRAWAL flow.',
      args: { input: t.arg({ type: InputRef, required: true }) },
      resolve: (_root, args, ctx) => ctx.services.incomeWithdrawal.request(args.input),
    }),
  );
}
