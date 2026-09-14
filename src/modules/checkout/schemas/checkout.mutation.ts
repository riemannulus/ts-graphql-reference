import { builder } from '../../../graphql/builder.js';
import type { CheckoutResult } from '../checkout.port.js';

export function registerCheckoutMutations(): void {
  const CheckoutCommissionInput = builder.inputType('CheckoutCommissionInput', {
    fields: (t) => ({
      orderPaymentId: t.int({ required: true }),
      actorId: t.int({ required: true }),
      commandKey: t.string({ required: true }),
    }),
  });
  const CheckoutCommissionResult = builder.objectRef<CheckoutResult>('CheckoutCommissionResult');
  CheckoutCommissionResult.implement({
    description: 'PROTOTYPE result of an atomic initial commission checkout.',
    fields: (t) => ({
      orderId: t.exposeInt('orderId'),
      orderPaymentId: t.exposeInt('orderPaymentId'),
      contractId: t.exposeInt('contractId'),
      reservationId: t.exposeInt('reservationId'),
      replayed: t.exposeBoolean('replayed'),
    }),
  });

  builder.mutationField('checkoutCommission', (t) =>
    t.field({
      type: CheckoutCommissionResult,
      description: 'PROTOTYPE: reserves POINT and forms a Contract in one transaction.',
      args: { input: t.arg({ type: CheckoutCommissionInput, required: true }) },
      resolve: (_root, args, ctx) =>
        ctx.services.checkout.payOrder({
          orderPaymentId: args.input.orderPaymentId,
          actorId: args.input.actorId,
          commandKey: args.input.commandKey,
        }),
    }),
  );
}
