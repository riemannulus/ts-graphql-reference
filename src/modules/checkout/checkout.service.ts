import { createHash } from 'node:crypto';
import type { Db } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import { uow } from '../../db/uow.js';
import {
  buildContractFormation,
  planCheckoutStart,
  validatePaymentIntent,
} from './checkout.core.js';
import type { CheckoutFacts, CheckoutInput, CheckoutPorts } from './checkout.port.js';
import {
  findCheckoutCommand,
  findCheckoutCommandByPayment,
  saveCheckoutCommand,
} from './checkout.repo.js';

function payloadHash(input: CheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.orderPaymentId, input.actorId]))
    .digest('hex');
}

export function createCheckoutService(deps: { db: Db; ports: CheckoutPorts }) {
  return {
    async payOrder(input: CheckoutInput) {
      const requestedPayloadHash = payloadHash(input);
      const targets = await deps.ports.locateOrderLockTargets(input.orderPaymentId);
      const financialHolderId = await deps.ports.locateFinancialHolder({
        namespace: 'user',
        key: String(targets.buyerId),
      });
      return uow.serialized(
        deps.db,
        [
          lockKey.orderPayment(input.orderPaymentId),
          lockKey.financialHolder(financialHolderId),
          lockKey.commissionSlot(targets.slotId),
          lockKey.checkoutCommand(input.commandKey),
        ],
        async (tx) => {
          const owner = deps.ports.bindTransaction(tx);
          const stored = await findCheckoutCommand(tx, input.commandKey);
          const completed = await findCheckoutCommandByPayment(tx, input.orderPaymentId);
          const start = planCheckoutStart(stored, completed, requestedPayloadHash, input.actorId);
          if (start.kind === 'REPLAY') {
            if (start.saveAlias) {
              await saveCheckoutCommand(tx, input, requestedPayloadHash, start.result);
            }
            return { ...start.result, replayed: true };
          }
          const payment = await owner.order.loadPayment(input.orderPaymentId);
          // Interactive transaction handles execute sequentially.
          const commissionType = await owner.commissionType.load(payment.commissionTypeId);
          const slot = await owner.slot.load(payment.slotId);
          const holderId = await owner.finance.locateHolder({
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
          const receipt = await owner.finance.reserve(intent.financialRequest);
          const formation = buildContractFormation(intent, receipt);
          const contract = await owner.contract.create(formation);
          await owner.order.markPaid({
            orderId: intent.orderId,
            orderPaymentId: intent.orderPaymentId,
            reservationId: receipt.reservationId,
          });
          await owner.slot.confirm({ slotId: intent.slotId, workerId: intent.workerId });
          const result = {
            orderId: intent.orderId,
            orderPaymentId: intent.orderPaymentId,
            contractId: contract.contractId,
            reservationId: receipt.reservationId,
          };
          await saveCheckoutCommand(tx, input, requestedPayloadHash, result);
          return { ...result, replayed: false };
        },
      );
    },
  };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
