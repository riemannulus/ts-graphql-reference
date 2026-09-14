import { createHash } from 'node:crypto';
import type { Db, DbClient } from '../../db/db.js';
import { lockKey } from '../../db/lock-registry.js';
import type { LockKey } from '../../db/locks.js';
import { uow } from '../../db/uow.js';
import * as commissionTypeRepo from '../commission-type/commission-type.repo.js';
import * as contractRepo from '../contract/contract.repo.js';
import { planReservation, type FinancialAllocation } from '../financial-ledger/financial-ledger.core.js';
import * as financialLedgerRepo from '../financial-ledger/financial-ledger.repo.js';
import * as orderRepo from '../order/order.repo.js';
import * as slotRepo from '../slot/slot.repo.js';
import {
  assertLockedCheckoutTargets,
  planCheckout,
  planCheckoutStart,
  type CheckoutInput,
  type CheckoutPlan,
  type CheckoutResult,
} from './checkout.core.js';
import {
  findCheckoutCommand,
  findCheckoutCommandByPayment,
  saveCheckoutCommand,
} from './checkout.repo.js';

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

interface ExecutableCheckoutPlan {
  checkout: CheckoutPlan;
  reservation: {
    accountId: number;
    allocations: FinancialAllocation[];
  };
}

type EconomicResult = Omit<CheckoutResult, 'replayed'>;

export function createCheckoutService(db: Db) {
  async function payOrder(input: CheckoutInput): Promise<CheckoutResult> {
    const checkout = await prepareCheckout(db, input);

    return uow.serialized(db, checkout.lockKeys, (tx) => executeCheckout(tx, checkout));
  }

  return { payOrder };
}

async function prepareCheckout(db: Db, input: CheckoutInput): Promise<PreparedCheckout> {
  const orderTargets = await orderRepo.findLockTargets(db.rw, input.orderPaymentId);
  const financialHolderId = await financialLedgerRepo.findHolderId(db.rw, {
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
  checkout: PreparedCheckout,
): Promise<CheckoutResult> {
  const replay = await replayCompletedCheckout(tx, checkout);
  if (replay) return replay;

  const plan = await loadCheckoutPlan(tx, checkout);
  const result = await applyCheckoutPlan(tx, plan);

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

async function loadCheckoutPlan(
  tx: DbClient,
  checkout: PreparedCheckout,
): Promise<ExecutableCheckoutPlan> {
  // Interactive transaction handles execute sequentially.
  // Product domain: load the Order payment, commission type, and Slot facts.
  const payment = await orderRepo.loadPaymentFacts(tx, checkout.input.orderPaymentId);
  const commissionType = await commissionTypeRepo.findCommissionTypeForCheckout(
    tx,
    payment.commissionTypeId,
  );
  const slot = await slotRepo.findSlotForCheckout(tx, payment.slotId);

  // Ledger domain: resolve the buyer's POINT holder used by the acquired lock.
  const financialHolderId = await financialLedgerRepo.findHolderId(tx, {
    namespace: 'user',
    key: String(payment.buyerId),
  });

  assertLockedCheckoutTargets(checkout.lockedTargets, {
    buyerId: payment.buyerId,
    slotId: payment.slotId,
    financialHolderId,
  });

  // Product/Ledger boundary: plan Product transitions and the Ledger reservation request.
  const plan = planCheckout(
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

  // Ledger domain: plan the FIFO POINT reservation from the holder's available lots.
  const pointWorld = await financialLedgerRepo.loadAvailablePointWorld(
    tx,
    plan.financialRequest.holderId,
  );

  return {
    checkout: plan,
    reservation: {
      accountId: pointWorld.accountId,
      allocations: planReservation(pointWorld.lots, plan.financialRequest.amount),
    },
  };
}

async function applyCheckoutPlan(
  tx: DbClient,
  plan: ExecutableCheckoutPlan,
): Promise<EconomicResult> {
  // Ledger domain: reserve POINT lots and create the ESCROW transfer.
  const reservation = await financialLedgerRepo.applyReservation(
    tx,
    plan.checkout.financialRequest,
    plan.reservation.accountId,
    plan.reservation.allocations,
  );

  // Product domain: form Contract, complete Order/payment, link its reservation, and occupy Slot.
  const contract = await contractRepo.applyContractFormation(tx, plan.checkout.contract);
  await orderRepo.applyPaidOrder(tx, {
    ...plan.checkout.paidOrder,
    reservationId: reservation.id,
  });
  await slotRepo.applySlotOccupation(tx, plan.checkout.occupiedSlot);

  return {
    orderId: plan.checkout.paidOrder.orderId,
    orderPaymentId: plan.checkout.paidOrder.orderPaymentId,
    contractId: contract.id,
    reservationId: reservation.id,
  };
}

function hashCheckoutPayload(input: CheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.orderPaymentId, input.actorId]))
    .digest('hex');
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
