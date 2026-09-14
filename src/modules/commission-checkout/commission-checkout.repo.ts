import type { DbClient } from '../../db/db.js';

export async function loadCompletedCommissionCheckoutResult(
  db: DbClient,
  identity: {
    flowId: string;
    subjectKey: string;
    referenceId: string;
    commandId: string;
    operationId: string;
  },
) {
  const orderPaymentId = Number(identity.subjectKey);
  if (!Number.isSafeInteger(orderPaymentId)) {
    throw new Error(`Commission payment subject ${identity.subjectKey} is invalid`);
  }
  const payment = await db.orderPayment.findUniqueOrThrow({
    where: { id: orderPaymentId },
    select: {
      flowId: true,
      financialLink: { select: { reservationId: true } },
      order: { select: { id: true, buyerId: true, contract: { select: { id: true } } } },
    },
  });
  if (payment.flowId !== identity.flowId) {
    throw new Error(
      `Commission payment ${orderPaymentId} belongs to flow ${payment.flowId}, not ${identity.flowId}`,
    );
  }
  if (!payment.financialLink || !payment.order.contract) {
    throw new Error(`Commission payment ${orderPaymentId} has no completed result`);
  }
  return {
    buyerId: payment.order.buyerId,
    result: {
      orderId: payment.order.id,
      orderPaymentId,
      reservationId: payment.financialLink.reservationId,
      contractId: payment.order.contract.id,
      referenceId: identity.referenceId,
      commandId: identity.commandId,
      operationId: identity.operationId,
    },
  };
}
