import { builder } from '../../../graphql/builder.js';
import type { CommissionCheckoutResult } from '../commission-checkout.core.js';

export function registerCommissionCheckoutMutations(): void {
  const CommissionCheckoutInputRef = builder.inputType('CommissionCheckoutInput', {
    fields: (t) => ({
      orderPaymentId: t.int({ required: true }),
      actorId: t.int({ required: true }),
      commandKey: t.string({ required: true }),
    }),
  });
  const CommissionCheckoutResultRef =
    builder.objectRef<CommissionCheckoutResult>('CommissionCheckoutResult');
  CommissionCheckoutResultRef.implement({
    description: 'PROTOTYPE result of an atomic initial commission checkout.',
    fields: (t) => ({
      orderId: t.exposeInt('orderId'),
      orderPaymentId: t.exposeInt('orderPaymentId'),
      contractId: t.exposeInt('contractId'),
      reservationId: t.exposeInt('reservationId'),
      referenceId: t.exposeString('referenceId'),
      commandId: t.exposeString('commandId'),
      operationId: t.exposeString('operationId'),
      replayed: t.exposeBoolean('replayed'),
    }),
  });

  builder.mutationField('checkoutCommission', (t) =>
    t.field({
      type: CommissionCheckoutResultRef,
      description: 'PROTOTYPE: reserves POINT and forms a Contract in one transaction.',
      args: { input: t.arg({ type: CommissionCheckoutInputRef, required: true }) },
      resolve: (_root, args, ctx) =>
        ctx.services.commissionCheckout.complete({
          orderPaymentId: args.input.orderPaymentId,
          actorId: args.input.actorId,
          commandKey: args.input.commandKey,
        }),
    }),
  );
}
