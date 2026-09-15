import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';
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

export interface CommissionCheckoutPaymentSnapshot {
  order: {
    id: number;
    buyerId: number;
    commissionTypeId: number;
    slotId: number;
    flowId: string;
    amount: number;
    currency: string;
    state: string;
  };
  payment: {
    id: number;
    flowId: string;
    amount: number;
    currency: string;
    state: string;
  };
}

export async function loadCommissionCheckoutPaymentSnapshot(
  db: ReadDbClient,
  orderPaymentId: number,
): Promise<CommissionCheckoutPaymentSnapshot> {
  const row = await db.orderPayment.findUnique({
    where: { id: orderPaymentId },
    select: {
      id: true,
      flowId: true,
      order: {
        select: {
          id: true,
          buyerId: true,
          commissionTypeId: true,
          slotId: true,
          flowId: true,
          amount: true,
          currency: true,
          state: true,
        },
      },
      amount: true,
      currency: true,
      state: true,
    },
  });
  if (!row) throw new OrderPaymentNotFoundError(orderPaymentId);
  return {
    order: row.order,
    payment: {
      id: row.id,
      flowId: row.flowId,
      amount: row.amount,
      currency: row.currency,
      state: row.state,
    },
  };
}

export interface CommissionSettlementOrderSnapshot {
  order: {
    id: number;
    flowId: string;
    buyerId: number;
    state: string;
    amount: number;
    currency: string;
  };
  payment: {
    id: number;
    flowId: string;
    state: string;
    amount: number;
    currency: string;
    fundingLink: { reservationId: number; flowId: string };
  };
}

export async function loadCommissionSettlementOrderSnapshot(
  db: ReadDbClient,
  orderId: number,
): Promise<CommissionSettlementOrderSnapshot> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      flowId: true,
      buyerId: true,
      state: true,
      amount: true,
      currency: true,
      payments: {
        where: { state: 'PAID' },
        orderBy: { id: 'asc' },
        take: 1,
        select: {
          id: true,
          flowId: true,
          state: true,
          amount: true,
          currency: true,
          financialLink: { select: { flowId: true, reservationId: true } },
        },
      },
    },
  });
  const payment = order?.payments[0];
  if (!order || !payment?.financialLink) {
    throw new DomainError(`Paid commission Order ${orderId} does not exist`, 'PAID_ORDER_NOT_FOUND');
  }
  return {
    order: {
      id: order.id,
      flowId: order.flowId,
      buyerId: order.buyerId,
      state: order.state,
      amount: order.amount,
      currency: order.currency,
    },
    payment: {
      id: payment.id,
      flowId: payment.flowId,
      state: payment.state,
      amount: payment.amount,
      currency: payment.currency,
      fundingLink: payment.financialLink,
    },
  };
}

export async function applyCommissionCheckoutPayment(
  db: DbClient,
  input: { orderId: number; orderPaymentId: number; flowId: string; reservationId: number },
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
    data: {
      orderPaymentId: input.orderPaymentId,
      flowId: input.flowId,
      reservationId: input.reservationId,
    },
  });
}
