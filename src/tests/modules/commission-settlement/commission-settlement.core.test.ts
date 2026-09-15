import { describe, expect, it } from 'vitest';
import {
  CommissionSettlementStateError,
  planCommissionSettlement,
  type CommissionSettlementWorld,
} from '../../../modules/commission-settlement/commission-settlement.core.js';

const facts = {
  contract: {
    id: 11,
    orderId: 21,
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    workerId: 31,
  },
  order: {
    id: 21,
    buyerId: 30,
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    state: 'PAID',
    amount: 500,
    currency: 'POINT',
  },
  payment: {
    id: 22,
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    state: 'PAID',
    amount: 500,
    currency: 'POINT',
    fundingLink: {
      reservationId: 41,
      flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    },
  },
  funding: {
    reservation: {
      id: 41,
      flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      state: 'HELD',
      currency: 'POINT',
      targetAmount: 500,
      holderBinding: { namespace: 'user', key: '30' },
      escrowAccountId: 51,
    },
    transfer: {
      flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      currency: 'POINT',
      amount: 500,
      toAccountId: 51,
    },
    provenance: {
      action: { operationKind: 'PAY' },
      operation: {
        id: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
        kind: 'PAY',
      },
      command: {
        flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
        kind: 'PAY',
        principalId: 30,
        subject: { namespace: 'commission-order-payment', key: '22' },
        resultOperationId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
      },
    },
  },
  accounts: {
    beneficiaryHolderId: 55,
    point: { settledAccountId: 52 },
    income: { issuerAccountId: 53, availableAccountId: 54 },
  },
} as const;

function withPayment(patch: Partial<CommissionSettlementWorld['payment']>) {
  return { ...facts, payment: { ...facts.payment, ...patch } };
}

function withReservation(
  patch: Partial<CommissionSettlementWorld['funding']['reservation']>,
) {
  return {
    ...facts,
    funding: {
      ...facts.funding,
      reservation: { ...facts.funding.reservation, ...patch },
    },
  };
}

function withTransfer(patch: Partial<CommissionSettlementWorld['funding']['transfer']>) {
  return {
    ...facts,
    funding: {
      ...facts.funding,
      transfer: { ...facts.funding.transfer, ...patch },
    },
  };
}

function withCommand(
  patch: Partial<CommissionSettlementWorld['funding']['provenance']['command']>,
) {
  return {
    ...facts,
    funding: {
      ...facts.funding,
      provenance: {
        ...facts.funding.provenance,
        command: { ...facts.funding.provenance.command, ...patch },
      },
    },
  };
}

describe('planCommissionSettlement', () => {
  it('plans a same-flow SETTLE command and a 1:1 POINT-to-INCOME swap', () => {
    expect(
      planCommissionSettlement(facts, {
        contractId: facts.contract.id,
        actorId: facts.contract.workerId,
        commandKey: 'settle-1',
      }),
    ).toEqual({
      commandRequest: {
        flowId: facts.contract.flowId,
        flowKind: 'COMMISSION',
        kind: 'SETTLE',
        principalId: facts.contract.workerId,
        idempotencyKey: 'settle-1',
        subjectNamespace: 'commission-contract',
        subjectKey: String(facts.contract.id),
      },
      operationRequest: { kind: 'SETTLE', actionKind: 'SWAP' },
      swap: {
        flowId: facts.contract.flowId,
        reservationId: facts.funding.reservation.id,
        beneficiaryHolderId: facts.accounts.beneficiaryHolderId,
        amount: 500,
        pointLeg: {
          currency: 'POINT',
          fromAccountId: facts.funding.reservation.escrowAccountId,
          toAccountId: facts.accounts.point.settledAccountId,
        },
        incomeLeg: {
          currency: 'INCOME',
          fromAccountId: facts.accounts.income.issuerAccountId,
          toAccountId: facts.accounts.income.availableAccountId,
        },
        incomeLot: {
          accountId: facts.accounts.income.availableAccountId,
          currency: 'INCOME',
          sourceKind: 'COMMISSION_SETTLEMENT',
          originalAmount: 500,
        },
      },
    });
  });

  it.each([
    [{ ...facts, order: { ...facts.order, state: 'REQUESTED' } }, 'paid'],
    [withPayment({ state: 'PENDING' }), 'paid'],
    [withPayment({ flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ff' }), 'flow'],
    [withReservation({ state: 'SETTLED' }), 'held'],
    [withReservation({ currency: 'INCOME' }), 'POINT'],
    [withTransfer({ amount: 499 }), 'funded amount'],
    [withTransfer({ toAccountId: 999 }), 'escrow'],
    [
      withPayment({
        fundingLink: { ...facts.payment.fundingLink, reservationId: 999 },
      }),
      'Order-owned',
    ],
    [withCommand({ kind: 'SETTLE' }), 'completed PAY'],
    [withCommand({ resultOperationId: null }), 'completed PAY'],
    [withCommand({ principalId: 999 }), 'principal'],
    [
      withCommand({
        subject: { ...facts.funding.provenance.command.subject, key: '999' },
      }),
      'payment subject',
    ],
    [
      withReservation({
        holderBinding: { ...facts.funding.reservation.holderBinding, key: '999' },
      }),
      'buyer holder',
    ],
    [withReservation({ flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ff' }), 'flow'],
  ])('rejects invalid settlement facts', (invalidFacts, message) => {
    expect(() =>
      planCommissionSettlement(invalidFacts, {
        contractId: facts.contract.id,
        actorId: facts.contract.workerId,
        commandKey: 'settle-1',
      }),
    ).toThrow(new RegExp(message, 'i'));
  });

  it('rejects settlement by anyone except the contract worker', () => {
    expect(() =>
      planCommissionSettlement(facts, {
        contractId: facts.contract.id,
        actorId: 999,
        commandKey: 'settle-1',
      }),
    ).toThrow(CommissionSettlementStateError);
  });
});
