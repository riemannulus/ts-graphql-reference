import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';
import type { FinancialAllocation } from './financial-ledger.core.js';

export class FinancialHolderNotFoundError extends DomainError {
  constructor(namespace: string, key: string) {
    super(`Financial holder ${namespace}:${key} does not exist`, 'FINANCIAL_HOLDER_NOT_FOUND');
  }
}

export class AvailableAccountNotFoundError extends DomainError {
  constructor(holderId: number, currency = 'POINT') {
    super(
      `${currency} AVAILABLE account for holder ${holderId} does not exist`,
      'AVAILABLE_ACCOUNT_NOT_FOUND',
    );
  }
}

export class CommissionSettlementFundingNotFoundError extends DomainError {
  constructor(reservationId: number) {
    super(
      `Funded commission reservation ${reservationId} does not exist`,
      'COMMISSION_SETTLEMENT_FUNDING_NOT_FOUND',
    );
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
    const result = await db.financialLot.updateMany({
      where: { id: allocation.lotId, accountId, remainingAmount: allocation.assumedRemainingAmount },
      data: { remainingAmount: { decrement: allocation.amount } },
    });
    if (result.count !== 1) throw new ConcurrentUpdateError(`FinancialLot ${allocation.lotId}`);
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
      currency: request.currency,
      fromAccountId: accountId,
      toAccountId: escrow.id,
      amount: request.amount,
      actionId,
    },
  });
  await db.financialTransferAllocation.createMany({
    data: allocations.map((allocation) => ({
      transferId: transfer.id,
      fromAccountId: accountId,
      currency: request.currency,
      lotId: allocation.lotId,
      amount: allocation.amount,
    })),
  });
  return reservation;
}

export function createTransferAction(
  db: DbClient,
  input: { operationId: string; flowId: string; operationKind: 'PAY' | 'WITHDRAW' },
) {
  return db.financialTransferAction.create({
    data: input,
    select: { id: true, flowId: true },
  });
}

async function findAccountId(
  db: ReadDbClient,
  input: { holderId: number; currency: string; purpose: string },
) {
  const account = await db.financialAccount.findUnique({
    where: { holderId_currency_purpose: input },
    select: { id: true },
  });
  if (!account) {
    throw new DomainError(
      `${input.currency} ${input.purpose} account for holder ${input.holderId} does not exist`,
      'FINANCIAL_ACCOUNT_NOT_FOUND',
    );
  }
  return account.id;
}

export interface CommissionSettlementAccounts {
  beneficiaryHolderId: number;
  point: { settledAccountId: number };
  income: { issuerAccountId: number; availableAccountId: number };
}

export async function loadCommissionSettlementAccounts(
  db: ReadDbClient,
  workerHolderId: number,
): Promise<CommissionSettlementAccounts> {
  const platformHolderId = await findHolderId(db, { namespace: 'system', key: 'platform' });
  // Sequential reads keep this compatible with every interactive-transaction adapter.
  const pointSettledAccountId = await findAccountId(db, {
    holderId: platformHolderId,
    currency: 'POINT',
    purpose: 'SETTLED',
  });
  const incomeIssuerAccountId = await findAccountId(db, {
    holderId: platformHolderId,
    currency: 'INCOME',
    purpose: 'ISSUER',
  });
  const incomeAvailableAccountId = await findAccountId(db, {
    holderId: workerHolderId,
    currency: 'INCOME',
    purpose: 'AVAILABLE',
  });
  return {
    beneficiaryHolderId: workerHolderId,
    point: { settledAccountId: pointSettledAccountId },
    income: {
      issuerAccountId: incomeIssuerAccountId,
      availableAccountId: incomeAvailableAccountId,
    },
  };
}

export interface CommissionSettlementFunding {
  reservation: {
    id: number;
    flowId: string;
    state: string;
    currency: string;
    targetAmount: number;
    holderBinding: { namespace: string; key: string };
    escrowAccountId: number;
  };
  transfer: {
    flowId: string;
    currency: string;
    amount: number;
    toAccountId: number;
  };
  provenance: {
    action: { operationKind: string };
    operation: { id: string; flowId: string; kind: string };
    command: {
      flowId: string;
      kind: string;
      principalId: number;
      subject: { namespace: string; key: string };
      resultOperationId: string | null;
    };
  };
}

const fundingCommandSelect = {
  kind: true,
  flowId: true,
  principalId: true,
  subjectNamespace: true,
  subjectKey: true,
  resultOperationId: true,
} as const;

const fundingOperationSelect = {
  id: true,
  flowId: true,
  kind: true,
  originatingCommand: { select: fundingCommandSelect },
} as const;

const fundingActionSelect = {
  operationKind: true,
  operation: { select: fundingOperationSelect },
} as const;

const fundingTransferSelect = {
  flowId: true,
  currency: true,
  amount: true,
  toAccountId: true,
  action: { select: fundingActionSelect },
} as const;

const commissionSettlementFundingSelect = {
  id: true,
  flowId: true,
  state: true,
  currency: true,
  targetAmount: true,
  holder: { select: { bindingNamespace: true, bindingKey: true } },
  escrowAccount: { select: { id: true } },
  transfer: { select: fundingTransferSelect },
} as const;

export async function loadCommissionSettlementFunding(
  db: ReadDbClient,
  reservationId: number,
): Promise<CommissionSettlementFunding> {
  const reservation = await db.financialReservation.findUnique({
    where: { id: reservationId },
    select: commissionSettlementFundingSelect,
  });
  if (!reservation?.escrowAccount || !reservation.transfer) {
    throw new CommissionSettlementFundingNotFoundError(reservationId);
  }
  const { holder, escrowAccount, transfer } = reservation;
  const { action } = transfer;
  const { operation } = action;
  const command = operation.originatingCommand;

  return {
    reservation: {
      id: reservation.id,
      flowId: reservation.flowId,
      state: reservation.state,
      currency: reservation.currency,
      targetAmount: reservation.targetAmount,
      holderBinding: {
        namespace: holder.bindingNamespace,
        key: holder.bindingKey,
      },
      escrowAccountId: escrowAccount.id,
    },
    transfer: {
      flowId: transfer.flowId,
      currency: transfer.currency,
      amount: transfer.amount,
      toAccountId: transfer.toAccountId,
    },
    provenance: {
      action: { operationKind: action.operationKind },
      operation: {
        id: operation.id,
        flowId: operation.flowId,
        kind: operation.kind,
      },
      command: {
        flowId: command.flowId,
        kind: command.kind,
        principalId: command.principalId,
        subject: {
          namespace: command.subjectNamespace,
          key: command.subjectKey,
        },
        resultOperationId: command.resultOperationId,
      },
    },
  };
}

export async function applyCommissionIncomeSettlement(
  db: DbClient,
  input: {
    flowId: string;
    reservationId: number;
    beneficiaryHolderId: number;
    operationId: string;
    amount: number;
    pointLeg: { currency: 'POINT'; fromAccountId: number; toAccountId: number };
    incomeLeg: { currency: 'INCOME'; fromAccountId: number; toAccountId: number };
    incomeLot: {
      accountId: number;
      currency: 'INCOME';
      sourceKind: 'COMMISSION_SETTLEMENT';
      originalAmount: number;
    };
  },
) {
  const action = await db.financialSwapAction.create({
    data: {
      flowId: input.flowId,
      operationId: input.operationId,
      reservationId: input.reservationId,
      operationKind: 'SETTLE',
      beneficiaryHolderId: input.beneficiaryHolderId,
    },
  });
  await db.financialSwapLeg.createMany({
    data: [input.pointLeg, input.incomeLeg].map((leg) => ({
      actionId: action.id,
      flowId: input.flowId,
      ...leg,
      amount: input.amount,
    })),
  });
  const lot = await db.financialLot.create({
    data: {
      ...input.incomeLot,
      sourceOperationId: input.operationId,
      sourceSwapActionId: action.id,
      sourceFlowId: input.flowId,
      sourceFlowKind: 'COMMISSION',
      sourceOperationKind: 'SETTLE',
      remainingAmount: input.incomeLot.originalAmount,
    },
  });
  const settled = await db.financialReservation.updateMany({
    where: { id: input.reservationId, flowId: input.flowId, state: 'HELD' },
    data: { state: 'SETTLED' },
  });
  if (settled.count !== 1) {
    throw new ConcurrentUpdateError(`FinancialReservation ${input.reservationId}`);
  }
  return { action, lot };
}

export async function assertCommissionSettlementShape(db: DbClient) {
  // PGlite does not fire deferred constraints at adapter callback commit, so
  // force them only after the command result and complete economic effect exist.
  await db.$executeRawUnsafe(
    'SET CONSTRAINTS "FinancialSwap_shape_check", "FinancialReservation_settlement_shape_check", "FinancialCommand_effect_completeness_check" IMMEDIATE',
  );
}

export async function loadAvailableIncomeWorld(db: ReadDbClient, holderId: number) {
  const account = await db.financialAccount.findUnique({
    where: { holderId_currency_purpose: { holderId, currency: 'INCOME', purpose: 'AVAILABLE' } },
    select: {
      id: true,
      lots: {
        where: { currency: 'INCOME', remainingAmount: { gt: 0 } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, remainingAmount: true },
      },
    },
  });
  if (!account) throw new AvailableAccountNotFoundError(holderId, 'INCOME');
  return {
    holderId,
    availableAccountId: account.id,
    lots: account.lots.map((lot) => ({ lotId: lot.id, remainingAmount: lot.remainingAmount })),
  };
}

export async function loadCommissionSettlementLedgerResult(
  db: ReadDbClient,
  operationId: string,
) {
  const action = await db.financialSwapAction.findUniqueOrThrow({
    where: { operationId },
    select: { reservationId: true },
  });
  const lot = await db.financialLot.findUniqueOrThrow({
    where: { sourceOperationId: operationId },
    select: { id: true },
  });
  return { reservationId: action.reservationId, incomeLotId: lot.id };
}

export async function loadIncomeWithdrawalSources(db: ReadDbClient, reservationId: number) {
  const reservation = await db.financialReservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: {
      transfer: {
        select: {
          allocations: {
            orderBy: { lotId: 'asc' },
            select: {
              amount: true,
              lot: { select: { sourceFlowId: true, sourceFlowKind: true } },
            },
          },
        },
      },
    },
  });
  const amounts = new Map<string, { flowKind: 'COMMISSION'; amount: number }>();
  for (const allocation of reservation.transfer?.allocations ?? []) {
    const { sourceFlowId, sourceFlowKind } = allocation.lot;
    if (!sourceFlowId || sourceFlowKind !== 'COMMISSION') {
      throw new DomainError('Withdrawal allocation has no commission source', 'INVALID_INCOME_SOURCE');
    }
    const current = amounts.get(sourceFlowId);
    amounts.set(sourceFlowId, {
      flowKind: sourceFlowKind,
      amount: (current?.amount ?? 0) + allocation.amount,
    });
  }
  return [...amounts].map(([flowId, source]) => ({ flowId, ...source }));
}

export async function applyIncomeWithdrawalReservation(
  db: DbClient,
  input: {
    flowId: string;
    request: {
      bindingNamespace: string;
      bindingKey: string;
      holderId: number;
      purpose: 'INCOME_WITHDRAWAL';
      currency: 'INCOME';
      amount: number;
      escrowAccount: { purpose: 'ESCROW'; currency: 'INCOME' };
      transfer: {
        currency: 'INCOME';
        amount: number;
        fromAccountId: number;
        allocations: readonly FinancialAllocation[];
      };
    };
    actionId: string;
  },
) {
  for (const allocation of input.request.transfer.allocations) {
    // Ledger domain: each optimistic decrement must observe the planned INCOME remainder.
    // eslint-disable-next-line no-await-in-loop
    const result = await db.financialLot.updateMany({
      where: {
        id: allocation.lotId,
        accountId: input.request.transfer.fromAccountId,
        currency: input.request.transfer.currency,
        remainingAmount: allocation.assumedRemainingAmount,
      },
      data: { remainingAmount: { decrement: allocation.amount } },
    });
    if (result.count !== 1) throw new ConcurrentUpdateError(`FinancialLot ${allocation.lotId}`);
  }
  const reservation = await db.financialReservation.create({
    data: {
      flowId: input.flowId,
      bindingNamespace: input.request.bindingNamespace,
      bindingKey: input.request.bindingKey,
      holderId: input.request.holderId,
      purpose: input.request.purpose,
      currency: input.request.currency,
      targetAmount: input.request.amount,
    },
  });
  const escrow = await db.financialAccount.create({
    data: { reservationId: reservation.id, ...input.request.escrowAccount },
  });
  const transfer = await db.financialTransfer.create({
    data: {
      reservationId: reservation.id,
      flowId: input.flowId,
      currency: input.request.transfer.currency,
      fromAccountId: input.request.transfer.fromAccountId,
      toAccountId: escrow.id,
      amount: input.request.transfer.amount,
      actionId: input.actionId,
    },
  });
  await db.financialTransferAllocation.createMany({
    data: input.request.transfer.allocations.map((allocation) => ({
      transferId: transfer.id,
      fromAccountId: input.request.transfer.fromAccountId,
      currency: input.request.transfer.currency,
      lotId: allocation.lotId,
      amount: allocation.amount,
    })),
  });
  return reservation;
}
