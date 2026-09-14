import type { DbClient } from '../../db/db.js';
import type { CheckoutInput, CheckoutResult } from './checkout.port.js';

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
