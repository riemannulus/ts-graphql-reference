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
  assertLockedCommissionCheckoutTargets,
  planCommissionCheckout,
  planCommissionCheckoutStart,
  type CommissionCheckoutInput,
  type CommissionCheckoutPlan,
  type CommissionCheckoutResult,
} from './commission-checkout.core.js';
import {
  findCommissionCheckoutCommand,
  findCommissionCheckoutCommandByPayment,
  saveCommissionCheckoutCommand,
} from './commission-checkout.repo.js';

const COMMISSION_BUYER_HOLDER_NAMESPACE = 'user';

interface LockedCommissionCheckoutTargets {
  buyerId: number;
  slotId: number;
  financialHolderId: number;
}

interface PreparedCommissionCheckout {
  input: CommissionCheckoutInput;
  payloadHash: string;
  lockedTargets: LockedCommissionCheckoutTargets;
  lockKeys: LockKey[];
}

interface ExecutableCommissionCheckoutPlan {
  commissionPlan: CommissionCheckoutPlan;
  reservation: {
    accountId: number;
    allocations: FinancialAllocation[];
  };
}

type CommissionCheckoutEconomicResult = Omit<CommissionCheckoutResult, 'replayed'>;

export function createCommissionCheckoutService(db: Db) {
  async function complete(input: CommissionCheckoutInput): Promise<CommissionCheckoutResult> {
    const prepared = await prepareCommissionCheckout(db, input);

    return uow.serialized(db, prepared.lockKeys, (tx) =>
      executeCommissionCheckout(tx, prepared),
    );
  }

  return { complete };
}

async function prepareCommissionCheckout(
  db: Db,
  input: CommissionCheckoutInput,
): Promise<PreparedCommissionCheckout> {
  const orderTargets = await orderRepo.findCommissionCheckoutLockTargets(
    db.rw,
    input.orderPaymentId,
  );
  const financialHolderId = await financialLedgerRepo.findHolderId(db.rw, {
    namespace: COMMISSION_BUYER_HOLDER_NAMESPACE,
    key: String(orderTargets.buyerId),
  });

  return {
    input,
    payloadHash: hashCommissionCheckoutPayload(input),
    lockedTargets: { ...orderTargets, financialHolderId },
    lockKeys: [
      lockKey.orderPayment(input.orderPaymentId),
      lockKey.financialHolder(financialHolderId),
      lockKey.commissionSlot(orderTargets.slotId),
      lockKey.commissionCheckoutCommand(input.commandKey),
    ],
  };
}

async function executeCommissionCheckout(
  tx: DbClient,
  prepared: PreparedCommissionCheckout,
): Promise<CommissionCheckoutResult> {
  const replay = await replayCompletedCommissionCheckout(tx, prepared);
  if (replay) return replay;

  const plan = await loadCommissionCheckoutPlan(tx, prepared);
  const result = await applyCommissionCheckoutPlan(tx, plan);

  await saveCommissionCheckoutCommand(tx, prepared.input, prepared.payloadHash, result);
  return { ...result, replayed: false };
}

async function replayCompletedCommissionCheckout(
  tx: DbClient,
  prepared: PreparedCommissionCheckout,
): Promise<CommissionCheckoutResult | null> {
  // Interactive transaction handles execute sequentially.
  const stored = await findCommissionCheckoutCommand(tx, prepared.input.commandKey);
  const completed = await findCommissionCheckoutCommandByPayment(
    tx,
    prepared.input.orderPaymentId,
  );
  const start = planCommissionCheckoutStart(
    stored,
    completed,
    prepared.payloadHash,
    prepared.input.actorId,
  );

  if (start.kind === 'PROCEED') return null;
  if (start.saveAlias) {
    await saveCommissionCheckoutCommand(tx, prepared.input, prepared.payloadHash, start.result);
  }
  return { ...start.result, replayed: true };
}

async function loadCommissionCheckoutPlan(
  tx: DbClient,
  prepared: PreparedCommissionCheckout,
): Promise<ExecutableCommissionCheckoutPlan> {
  // Interactive transaction handles execute sequentially.
  // Product domain: load the Order payment, commission type, and Slot facts.
  const payment = await orderRepo.loadCommissionCheckoutPaymentFacts(
    tx,
    prepared.input.orderPaymentId,
  );
  const commissionType = await commissionTypeRepo.loadCommissionCheckoutTerms(
    tx,
    payment.commissionTypeId,
  );
  const slot = await slotRepo.loadCommissionCheckoutSlot(tx, payment.slotId);

  // Ledger domain: resolve the buyer's POINT holder used by the acquired lock.
  const financialHolderId = await financialLedgerRepo.findHolderId(tx, {
    namespace: COMMISSION_BUYER_HOLDER_NAMESPACE,
    key: String(payment.buyerId),
  });

  assertLockedCommissionCheckoutTargets(prepared.lockedTargets, {
    buyerId: payment.buyerId,
    slotId: payment.slotId,
    financialHolderId,
  });

  // Product/Ledger boundary: plan Product transitions and the Ledger reservation request.
  const plan = planCommissionCheckout(
    {
      ...payment,
      commissionWorkerId: commissionType.workerId,
      commissionPrice: commissionType.price,
      slotWorkerId: slot.workerId,
      slotState: slot.state,
      financialHolderId,
    },
    prepared.input,
  );

  // Ledger domain: plan the FIFO POINT reservation from the holder's available lots.
  const pointWorld = await financialLedgerRepo.loadAvailablePointWorld(
    tx,
    plan.financialRequest.holderId,
  );

  return {
    commissionPlan: plan,
    reservation: {
      accountId: pointWorld.accountId,
      allocations: planReservation(pointWorld.lots, plan.financialRequest.amount),
    },
  };
}

async function applyCommissionCheckoutPlan(
  tx: DbClient,
  plan: ExecutableCommissionCheckoutPlan,
): Promise<CommissionCheckoutEconomicResult> {
  // Ledger domain: reserve POINT lots and create the ESCROW transfer.
  const reservation = await financialLedgerRepo.applyCommissionPaymentReservation(
    tx,
    plan.commissionPlan.financialRequest,
    plan.reservation.accountId,
    plan.reservation.allocations,
  );

  // Product domain: form Contract, complete Order/payment, link its reservation, and occupy Slot.
  const contract = await contractRepo.applyCommissionCheckoutContractFormation(
    tx,
    plan.commissionPlan.contract,
  );
  await orderRepo.applyCommissionCheckoutPayment(tx, {
    ...plan.commissionPlan.paidOrder,
    reservationId: reservation.id,
  });
  await slotRepo.applyCommissionCheckoutSlotOccupation(
    tx,
    plan.commissionPlan.occupiedSlot,
  );

  return {
    orderId: plan.commissionPlan.paidOrder.orderId,
    orderPaymentId: plan.commissionPlan.paidOrder.orderPaymentId,
    contractId: contract.id,
    reservationId: reservation.id,
  };
}

function hashCommissionCheckoutPayload(input: CommissionCheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.orderPaymentId, input.actorId]))
    .digest('hex');
}

export type CommissionCheckoutService = ReturnType<typeof createCommissionCheckoutService>;
