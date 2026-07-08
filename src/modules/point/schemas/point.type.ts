import { builder } from '../../../builder.js';
import { parsePointChargeState, POINT_CHARGE_STATES } from '../point.core.js';

export function registerPointTypes(): void {
  const PointChargeStateEnum = builder.enumType('PointChargeState', {
    values: POINT_CHARGE_STATES,
    description: 'Lifecycle state of a point charge.',
  });

  builder.prismaObject('PointBalance', {
    fields: (t) => ({
      paidAmount: t.exposeInt('paidAmount'),
      freeAmount: t.exposeInt('freeAmount'),
      totalAmount: t.exposeInt('totalAmount'),
      user: t.relation('user'),
    }),
  });

  builder.prismaObject('PointCharge', {
    fields: (t) => ({
      id: t.exposeID('id'),
      state: t.field({
        type: PointChargeStateEnum,
        // Parse, don't cast: an out-of-set DB value throws (masked) instead of
        // silently passing through the API.
        resolve: (charge) => parsePointChargeState(charge.state),
      }),
      paidAmount: t.exposeInt('paidAmount'),
      freeAmount: t.exposeInt('freeAmount'),
      unspentPaidAmount: t.exposeInt('unspentPaidAmount'),
      unspentFreeAmount: t.exposeInt('unspentFreeAmount'),
      chargedAt: t.string({ resolve: (charge) => charge.chargedAt.toISOString() }),
      user: t.relation('user'),
    }),
  });

  builder.prismaObject('PointSpend', {
    fields: (t) => ({
      id: t.exposeID('id'),
      paidAmount: t.exposeInt('paidAmount'),
      freeAmount: t.exposeInt('freeAmount'),
      totalAmount: t.exposeInt('totalAmount'),
      reason: t.exposeString('reason'),
      createdAt: t.string({ resolve: (spend) => spend.createdAt.toISOString() }),
      user: t.relation('user'),
    }),
  });
}
