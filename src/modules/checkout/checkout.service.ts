import { createHash } from 'node:crypto';
import type { Db } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import { buildContractFormation, validatePaymentIntent } from './checkout.core.js';
import type { CheckoutFacts, CheckoutInput, CheckoutPorts } from './checkout.port.js';
import { saveCheckoutCommand } from './checkout.repo.js';

function payloadHash(input: CheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.orderPaymentId, input.actorId]))
    .digest('hex');
}

export function createCheckoutService(deps: { db: Db; ports: CheckoutPorts }) {
  return {
    async payOrder(input: CheckoutInput) {
      const targets = await deps.ports.order.locateLockTargets(deps.db.rw, input.orderPaymentId);
      const financialHolderId = await deps.ports.finance.locateHolder(deps.db.rw, {
        namespace: 'user',
        key: String(targets.buyerId),
      });
      return uow.serialized(
        deps.db,
        [
          lockKey.orderPayment(input.orderPaymentId),
          lockKey.financialHolder(financialHolderId),
          lockKey.commissionSlot(targets.slotId),
        ],
        async (tx) => {
          const payment = await deps.ports.order.loadPayment(tx, input.orderPaymentId);
          // Interactive transaction handles execute sequentially.
          const commissionType = await deps.ports.commissionType.load(
            tx,
            payment.commissionTypeId,
          );
          const slot = await deps.ports.slot.load(tx, payment.slotId);
          const holderId = await deps.ports.finance.locateHolder(tx, {
            namespace: 'user',
            key: String(payment.buyerId),
          });
          const facts: CheckoutFacts = {
            ...payment,
            commissionWorkerId: commissionType.workerId,
            commissionPrice: commissionType.price,
            slotWorkerId: slot.workerId,
            slotState: slot.state,
            financialHolderId: holderId,
          };
          const intent = validatePaymentIntent(facts, input);
          const receipt = await deps.ports.finance.reserve(tx, intent.financialRequest);
          const formation = buildContractFormation(intent, receipt);
          const contract = await deps.ports.contract.create(tx, formation);
          await deps.ports.order.markPaid(tx, {
            orderId: intent.orderId,
            orderPaymentId: intent.orderPaymentId,
            reservationId: receipt.reservationId,
          });
          await deps.ports.slot.confirm(tx, { slotId: intent.slotId, workerId: intent.workerId });
          const result = {
            orderId: intent.orderId,
            orderPaymentId: intent.orderPaymentId,
            contractId: contract.contractId,
            reservationId: receipt.reservationId,
          };
          await saveCheckoutCommand(tx, input, payloadHash(input), result);
          return { ...result, replayed: false };
        },
        { snapshot: true },
      );
    },
  };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
