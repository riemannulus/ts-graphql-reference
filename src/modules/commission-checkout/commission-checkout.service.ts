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
  formatCommandId,
  formatOperationId,
  formatTransactionReference,
} from '../transaction-flow/transaction-flow.core.js';
import * as transactionFlowRepo from '../transaction-flow/transaction-flow.repo.js';
import {
  assertLockedCommissionCheckoutTargets,
  assertCommissionCheckoutReplayIdentity,
  planCommissionCheckout,
  planCommissionCheckoutCommand,
  planCommissionCheckoutStart,
  type CommissionCheckoutInput,
  type CommissionCheckoutPlan,
  type CommissionCheckoutResult,
} from './commission-checkout.core.js';
import { loadCompletedCommissionCheckoutResult } from './commission-checkout.repo.js';

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

type CommissionCheckoutDomainResult = Pick<
  CommissionCheckoutResult,
  'orderId' | 'orderPaymentId' | 'contractId' | 'reservationId'
>;

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
      lockKey.commissionCheckoutCommand(`${input.actorId}:PAY:${input.commandKey}`),
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
  const command = await transactionFlowRepo.startCommand(tx, {
    ...plan.commissionPlan.commandRequest,
    payloadHash: prepared.payloadHash,
  });
  const operation = await transactionFlowRepo.createTransferOperation(tx, {
    commandId: command.id,
    flowId: command.flowId,
    ...plan.commissionPlan.operationRequest,
  });
  const result = await applyCommissionCheckoutPlan(tx, plan, operation.action.id);

  return {
    ...result,
    referenceId: formatTransactionReference({
      kind: command.flowKind,
      id: command.flowId,
    }),
    commandId: formatCommandId({ kind: command.kind, id: command.id }),
    operationId: formatOperationId({ kind: operation.operation.kind, id: operation.operation.id }),
    replayed: false,
  };
}

async function replayCompletedCommissionCheckout(
  tx: DbClient,
  prepared: PreparedCommissionCheckout,
): Promise<CommissionCheckoutResult | null> {
  const requested = {
    ...planCommissionCheckoutCommand(prepared.input),
    payloadHash: prepared.payloadHash,
  };
  // Interactive transaction handles execute sequentially.
  const storedIdentity = await transactionFlowRepo.findCommand(tx, requested);
  if (storedIdentity) {
    // Validate the idempotency identity before dereferencing any product subject.
    assertCommissionCheckoutReplayIdentity(storedIdentity, requested);
    const completed = requireCompletedCommand(storedIdentity);
    const stored = await loadCompletedCommissionCheckoutResult(tx, completed);
    return { ...stored.result, replayed: true };
  }

  const completedIdentity = await transactionFlowRepo.findCompletedCommandBySubject(tx, requested);
  const completed = completedIdentity
    ? {
        ...(await loadCompletedCommissionCheckoutResult(
          tx,
          requireCompletedCommand(completedIdentity),
        )),
        payloadHash: completedIdentity.payloadHash,
      }
    : null;
  const start = planCommissionCheckoutStart(
    null,
    completed,
    prepared.payloadHash,
    prepared.input.actorId,
  );

  if (start.kind === 'PROCEED') return null;
  if (start.saveAlias) {
    if (!completedIdentity) throw new Error('Completed commission payment disappeared during replay');
    const completeIdentity = requireCompletedCommand(completedIdentity);
    const alias = await transactionFlowRepo.saveCommandAlias(tx, {
      flowId: completeIdentity.flowId,
      ...requested,
      resultOperationId: completeIdentity.operationDbId,
    });
    return {
      ...start.result,
      commandId: formatCommandId({ kind: alias.kind, id: alias.id }),
      replayed: true,
    };
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
  actionId: string,
): Promise<CommissionCheckoutDomainResult> {
  // Ledger domain: reserve POINT lots and create the ESCROW transfer.
  const reservation = await financialLedgerRepo.applyCommissionPaymentReservation(
    tx,
    plan.commissionPlan.financialRequest,
    plan.reservation.accountId,
    plan.reservation.allocations,
    actionId,
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

function requireCompletedCommand<T extends {
  operationDbId: string | null;
  operationId: string | null;
}>(identity: T): T & { operationDbId: string; operationId: string } {
  if (!identity.operationDbId || !identity.operationId) {
    throw new Error('Financial command has no completed economic result');
  }
  return identity as T & { operationDbId: string; operationId: string };
}

export type CommissionCheckoutService = ReturnType<typeof createCommissionCheckoutService>;
