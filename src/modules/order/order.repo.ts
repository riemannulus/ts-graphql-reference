import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError } from '../../foundation/errors.js';
import { OrderPaymentNotFoundError } from './order.core.js';

export async function findCommissionCheckoutLockTargets(
  db: ReadDbClient,
  orderPaymentId: number,
) {
  const row = await db.orderPayment.findUnique({
    where: { id: orderPaymentId },
    select: { order: { select: { buyerId: true, slotId: true } } },
  });
  if (!row) throw new OrderPaymentNotFoundError(orderPaymentId);
  return row.order;
}

export async function loadCommissionCheckoutPaymentFacts(
  db: ReadDbClient,
  orderPaymentId: number,
) {
  const row = await db.orderPayment.findUnique({
    where: { id: orderPaymentId },
    select: {
      id: true,
      referenceId: true,
      amount: true,
      currency: true,
      state: true,
      order: {
        select: {
          id: true,
          buyerId: true,
          commissionTypeId: true,
          slotId: true,
          amount: true,
          currency: true,
          state: true,
        },
      },
    },
  });
  if (!row) throw new OrderPaymentNotFoundError(orderPaymentId);
  return {
    orderId: row.order.id,
    orderPaymentId: row.id,
    buyerId: row.order.buyerId,
    commissionTypeId: row.order.commissionTypeId,
    slotId: row.order.slotId,
    referenceId: row.referenceId,
    orderAmount: row.order.amount,
    paymentAmount: row.amount,
    orderCurrency: row.order.currency,
    paymentCurrency: row.currency,
    orderState: row.order.state,
    paymentState: row.state,
  };
}

export async function applyCommissionCheckoutPayment(
  db: DbClient,
  input: { orderId: number; orderPaymentId: number; reservationId: number },
): Promise<void> {
  const payment = await db.orderPayment.updateMany({
    where: { id: input.orderPaymentId, orderId: input.orderId, state: 'PENDING' },
    data: { state: 'PAID' },
  });
  if (payment.count !== 1) throw new ConcurrentUpdateError(`OrderPayment ${input.orderPaymentId}`);
  const order = await db.order.updateMany({
    where: { id: input.orderId, state: 'REQUESTED' },
    data: { state: 'PAID' },
  });
  if (order.count !== 1) throw new ConcurrentUpdateError(`Order ${input.orderId}`);
  await db.orderFinancialLink.create({
    data: { orderPaymentId: input.orderPaymentId, reservationId: input.reservationId },
  });
}
