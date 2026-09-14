import { builder } from '../../../graphql/builder.js';
import type { CommissionSettlementResult } from '../commission-settlement.core.js';

export function registerCommissionSettlementMutations(): void {
  const InputRef = builder.inputType('CommissionSettlementInput', {
    fields: (t) => ({
      contractId: t.int({ required: true }),
      actorId: t.int({ required: true }),
      commandKey: t.string({ required: true }),
    }),
  });
  const ResultRef = builder.objectRef<CommissionSettlementResult>('CommissionSettlementResult');
  ResultRef.implement({
    description: 'PROTOTYPE result of POINT-to-INCOME commission settlement.',
    fields: (t) => ({
      contractId: t.exposeInt('contractId'),
      reservationId: t.exposeInt('reservationId'),
      incomeLotId: t.exposeInt('incomeLotId'),
      referenceId: t.exposeString('referenceId'),
      commandId: t.exposeString('commandId'),
      operationId: t.exposeString('operationId'),
      replayed: t.exposeBoolean('replayed'),
    }),
  });
  builder.mutationField('settleCommission', (t) =>
    t.field({
      type: ResultRef,
      description: 'PROTOTYPE: swaps held commission POINT into withdrawable INCOME.',
      args: { input: t.arg({ type: InputRef, required: true }) },
      resolve: (_root, args, ctx) => ctx.services.commissionSettlement.settle(args.input),
    }),
  );
}
