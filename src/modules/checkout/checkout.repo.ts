import type { DbClient } from '../../db/db.js';
import type { CheckoutInput, CheckoutResult } from './checkout.core.js';

const commandResultSelect = {
  commandKey: true,
  payloadHash: true,
  orderPaymentId: true,
  orderPayment: {
    select: {
      financialLink: { select: { reservationId: true } },
      order: { select: { id: true, buyerId: true, contract: { select: { id: true } } } },
    },
  },
} as const;

function mapStoredCommand(row: {
  commandKey: string;
  payloadHash: string;
  orderPaymentId: number;
  orderPayment: {
    financialLink: { reservationId: number } | null;
    order: { id: number; buyerId: number; contract: { id: number } | null };
  };
}) {
  const { financialLink } = row.orderPayment;
  const { contract } = row.orderPayment.order;
  if (!financialLink || !contract) {
    throw new Error(`Checkout command ${row.commandKey} has no completed economic result`);
  }
  return {
    commandKey: row.commandKey,
    payloadHash: row.payloadHash,
    buyerId: row.orderPayment.order.buyerId,
    result: {
      orderId: row.orderPayment.order.id,
      orderPaymentId: row.orderPaymentId,
      reservationId: financialLink.reservationId,
      contractId: contract.id,
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
    },
  });
}
