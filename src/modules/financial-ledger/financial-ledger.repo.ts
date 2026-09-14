import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';
import type { FinancialAllocation } from './financial-ledger.core.js';

export class FinancialHolderNotFoundError extends DomainError {
  constructor(namespace: string, key: string) {
    super(`Financial holder ${namespace}:${key} does not exist`, 'FINANCIAL_HOLDER_NOT_FOUND');
  }
}

export class AvailableAccountNotFoundError extends DomainError {
  constructor(holderId: number) {
    super(`POINT AVAILABLE account for holder ${holderId} does not exist`, 'AVAILABLE_ACCOUNT_NOT_FOUND');
  }
}

export async function findHolderId(
  db: ReadDbClient,
  binding: { namespace: string; key: string },
): Promise<number> {
  const holder = await db.financialHolder.findUnique({
    where: {
      bindingNamespace_bindingKey: {
        bindingNamespace: binding.namespace,
        bindingKey: binding.key,
      },
    },
    select: { id: true },
  });
  if (!holder) throw new FinancialHolderNotFoundError(binding.namespace, binding.key);
  return holder.id;
}

export async function loadAvailablePointWorld(db: ReadDbClient, holderId: number) {
  const account = await db.financialAccount.findUnique({
    where: {
      holderId_currency_purpose: { holderId, currency: 'POINT', purpose: 'AVAILABLE' },
    },
    select: {
      id: true,
      lots: {
        where: { remainingAmount: { gt: 0 } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, remainingAmount: true },
      },
    },
  });
  if (!account) throw new AvailableAccountNotFoundError(holderId);
  return {
    accountId: account.id,
    lots: account.lots.map((lot) => ({ lotId: lot.id, remainingAmount: lot.remainingAmount })),
  };
}

export async function applyCommissionPaymentReservation(
  db: DbClient,
  request: {
    flowId: string;
    bindingNamespace: string;
    bindingKey: string;
    holderId: number;
    purpose: 'COMMISSION_PAYMENT';
    currency: 'POINT';
    amount: number;
  },
  accountId: number,
  allocations: readonly FinancialAllocation[],
  actionId: string,
) {
  for (const allocation of allocations) {
    // Interactive transaction handles execute sequentially, and each guarded
    // update must complete before the next allocation is applied.
    // eslint-disable-next-line no-await-in-loop
    const result = await db.pointLot.updateMany({
      where: { id: allocation.lotId, accountId, remainingAmount: allocation.assumedRemainingAmount },
      data: { remainingAmount: { decrement: allocation.amount } },
    });
    if (result.count !== 1) throw new ConcurrentUpdateError(`PointLot ${allocation.lotId}`);
  }
  const reservation = await db.financialReservation.create({
    data: {
      flowId: request.flowId,
      bindingNamespace: request.bindingNamespace,
      bindingKey: request.bindingKey,
      holderId: request.holderId,
      purpose: request.purpose,
      currency: request.currency,
      targetAmount: request.amount,
    },
  });
  const escrow = await db.financialAccount.create({
    data: { currency: request.currency, purpose: 'ESCROW', reservationId: reservation.id },
  });
  const transfer = await db.financialTransfer.create({
    data: {
      reservationId: reservation.id,
      flowId: request.flowId,
      fromAccountId: accountId,
      toAccountId: escrow.id,
      amount: request.amount,
      actionId,
    },
  });
  await db.financialTransferAllocation.createMany({
    data: allocations.map((allocation) => ({
      transferId: transfer.id,
      lotId: allocation.lotId,
      amount: allocation.amount,
    })),
  });
  return reservation;
}
