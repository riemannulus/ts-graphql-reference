import { createHash } from 'node:crypto';
import type { Db, DbClient } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import type { LockKey } from '../../db/locks.js';
import { uow } from '../../db/uow.js';
import {
  assertLockedCheckoutTargets,
  buildContractFormation,
  planCheckoutStart,
  validatePaymentIntent,
} from './checkout.core.js';
import type {
  CheckoutInput,
  CheckoutPorts,
  CheckoutResult,
  CheckoutTransactionPorts,
  PaymentIntent,
} from './checkout.port.js';
import {
  findCheckoutCommand,
  findCheckoutCommandByPayment,
  saveCheckoutCommand,
} from './checkout.repo.js';

interface CheckoutDependencies {
  db: Db;
  ports: CheckoutPorts;
}

interface LockedCheckoutTargets {
  buyerId: number;
  slotId: number;
  financialHolderId: number;
}

interface PreparedCheckout {
  input: CheckoutInput;
  payloadHash: string;
  lockedTargets: LockedCheckoutTargets;
  lockKeys: LockKey[];
}

type EconomicResult = Omit<CheckoutResult, 'replayed'>;

export function createCheckoutService(deps: CheckoutDependencies) {
  async function payOrder(input: CheckoutInput): Promise<CheckoutResult> {
    const checkout = await prepareCheckout(deps.ports, input);

    return uow.serialized(deps.db, checkout.lockKeys, (tx) =>
      executeCheckout(tx, deps.ports, checkout),
    );
  }

  return { payOrder };
}

async function prepareCheckout(
  ports: CheckoutPorts,
  input: CheckoutInput,
): Promise<PreparedCheckout> {
  const orderTargets = await ports.locateOrderLockTargets(input.orderPaymentId);
  const financialHolderId = await ports.locateFinancialHolder({
    namespace: 'user',
    key: String(orderTargets.buyerId),
  });

  return {
    input,
    payloadHash: hashCheckoutPayload(input),
    lockedTargets: { ...orderTargets, financialHolderId },
    lockKeys: [
      lockKey.orderPayment(input.orderPaymentId),
      lockKey.financialHolder(financialHolderId),
      lockKey.commissionSlot(orderTargets.slotId),
      lockKey.checkoutCommand(input.commandKey),
    ],
  };
}

async function executeCheckout(
  tx: DbClient,
  ports: CheckoutPorts,
  checkout: PreparedCheckout,
): Promise<CheckoutResult> {
  const replay = await replayCompletedCheckout(tx, checkout);
  if (replay) return replay;

  const owner = ports.bindTransaction(tx);
  const intent = await loadAndValidatePaymentIntent(owner, checkout);
  const result = await applyCheckoutEffects(owner, intent);

  await saveCheckoutCommand(tx, checkout.input, checkout.payloadHash, result);
  return { ...result, replayed: false };
}

async function replayCompletedCheckout(
  tx: DbClient,
  checkout: PreparedCheckout,
): Promise<CheckoutResult | null> {
  // Interactive transaction handles execute sequentially.
  const stored = await findCheckoutCommand(tx, checkout.input.commandKey);
  const completed = await findCheckoutCommandByPayment(tx, checkout.input.orderPaymentId);
  const start = planCheckoutStart(
    stored,
    completed,
    checkout.payloadHash,
    checkout.input.actorId,
  );

  if (start.kind === 'PROCEED') return null;
  if (start.saveAlias) {
    await saveCheckoutCommand(tx, checkout.input, checkout.payloadHash, start.result);
  }
  return { ...start.result, replayed: true };
}

async function loadAndValidatePaymentIntent(
  owner: CheckoutTransactionPorts,
  checkout: PreparedCheckout,
): Promise<PaymentIntent> {
  const payment = await owner.order.loadPayment(checkout.input.orderPaymentId);
  // Interactive transaction handles execute sequentially.
  const commissionType = await owner.commissionType.load(payment.commissionTypeId);
  const slot = await owner.slot.load(payment.slotId);
  const financialHolderId = await owner.finance.locateHolder({
    namespace: 'user',
    key: String(payment.buyerId),
  });

  assertLockedCheckoutTargets(checkout.lockedTargets, {
    buyerId: payment.buyerId,
    slotId: payment.slotId,
    financialHolderId,
  });

  return validatePaymentIntent(
    {
      ...payment,
      commissionWorkerId: commissionType.workerId,
      commissionPrice: commissionType.price,
      slotWorkerId: slot.workerId,
      slotState: slot.state,
      financialHolderId,
    },
    checkout.input,
  );
}

async function applyCheckoutEffects(
  owner: CheckoutTransactionPorts,
  intent: PaymentIntent,
): Promise<EconomicResult> {
  const receipt = await owner.finance.reserve(intent.financialRequest);
  const contract = await owner.contract.create(buildContractFormation(intent, receipt));

  await owner.order.markPaid({
    orderId: intent.orderId,
    orderPaymentId: intent.orderPaymentId,
    reservationId: receipt.reservationId,
  });
  await owner.slot.confirm({ slotId: intent.slotId, workerId: intent.workerId });

  return {
    orderId: intent.orderId,
    orderPaymentId: intent.orderPaymentId,
    contractId: contract.contractId,
    reservationId: receipt.reservationId,
  };
}

function hashCheckoutPayload(input: CheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.orderPaymentId, input.actorId]))
    .digest('hex');
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
