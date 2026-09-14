import type { DbClient } from '../../db/db.js';
import type { CheckoutInput, CheckoutResult } from './checkout.port.js';

const commandResultSelect = {
  commandKey: true,
  payloadHash: true,
  orderPaymentId: true,
  reservationId: true,
  contractId: true,
  orderPayment: { select: { order: { select: { id: true, buyerId: true } } } },
} as const;

function mapStoredCommand(row: {
  commandKey: string;
  payloadHash: string;
  orderPaymentId: number;
  reservationId: number;
  contractId: number;
  orderPayment: { order: { id: number; buyerId: number } };
}) {
  return {
    commandKey: row.commandKey,
    payloadHash: row.payloadHash,
    buyerId: row.orderPayment.order.buyerId,
    result: {
      orderId: row.orderPayment.order.id,
      orderPaymentId: row.orderPaymentId,
      reservationId: row.reservationId,
      contractId: row.contractId,
    },
  };
}

export async function findCheckoutCommand(db: DbClient, commandKey: string) {
  const row = await db.checkoutCommand.findUnique({
    where: { commandKey },
    select: commandResultSelect,
  });
  return row ? mapStoredCommand(row) : null;
}

export async function findCheckoutCommandByPayment(db: DbClient, orderPaymentId: number) {
  const row = await db.checkoutCommand.findFirst({
    where: { orderPaymentId },
    orderBy: { createdAt: 'asc' },
    select: commandResultSelect,
  });
  return row ? mapStoredCommand(row) : null;
}

export function saveCheckoutCommand(
  db: DbClient,
  input: CheckoutInput,
  payloadHash: string,
  result: Omit<CheckoutResult, 'replayed'>,
) {
  return db.checkoutCommand.create({
    data: {
      commandKey: input.commandKey,
      payloadHash,
      orderPaymentId: result.orderPaymentId,
      reservationId: result.reservationId,
      contractId: result.contractId,
    },
  });
}
