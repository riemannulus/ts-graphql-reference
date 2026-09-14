import { describe, expect, it } from 'vitest';
import {
  CommissionSettlementStateError,
  planCommissionSettlement,
} from '../../../modules/commission-settlement/commission-settlement.core.js';

const facts = {
  contractId: 11,
  contractOrderId: 21,
  orderId: 21,
  orderBuyerId: 30,
  orderFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  workerId: 31,
  orderState: 'PAID',
  orderAmount: 500,
  orderCurrency: 'POINT',
  orderPaymentId: 22,
  paymentState: 'PAID',
  paymentAmount: 500,
  paymentCurrency: 'POINT',
  linkedReservationId: 41,
  linkedReservationFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  reservationId: 41,
  reservationFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  reservationState: 'HELD',
  reservationCurrency: 'POINT',
  reservationTargetAmount: 500,
  reservationHolderBindingNamespace: 'user',
  reservationHolderBindingKey: '30',
  pointEscrowAccountId: 51,
  fundingTransferId: 61,
  fundingTransferFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  fundingTransferCurrency: 'POINT',
  fundingTransferAmount: 500,
  fundingTransferToAccountId: 51,
  fundingActionOperationKind: 'PAY',
  fundingOperationId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
  fundingOperationFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  fundingOperationKind: 'PAY',
  fundingCommandFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
  fundingCommandKind: 'PAY',
  fundingCommandPrincipalId: 30,
  fundingCommandSubjectNamespace: 'commission-order-payment',
  fundingCommandSubjectKey: '22',
  fundingCommandResultOperationId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
  pointSettledAccountId: 52,
  incomeIssuerAccountId: 53,
  incomeAvailableAccountId: 54,
  beneficiaryHolderId: 55,
} as const;

describe('planCommissionSettlement', () => {
  it('plans a same-flow SETTLE command and a 1:1 POINT-to-INCOME swap', () => {
    expect(
      planCommissionSettlement(facts, {
        contractId: facts.contractId,
        actorId: facts.workerId,
        commandKey: 'settle-1',
      }),
    ).toEqual({
      commandRequest: {
        flowId: facts.flowId,
        flowKind: 'COMMISSION',
        kind: 'SETTLE',
        principalId: facts.workerId,
        idempotencyKey: 'settle-1',
        subjectNamespace: 'commission-contract',
        subjectKey: String(facts.contractId),
      },
      operationRequest: { kind: 'SETTLE', actionKind: 'SWAP' },
      swap: {
        flowId: facts.flowId,
        reservationId: facts.reservationId,
        beneficiaryHolderId: facts.beneficiaryHolderId,
        amount: 500,
        pointLeg: {
          currency: 'POINT',
          fromAccountId: facts.pointEscrowAccountId,
          toAccountId: facts.pointSettledAccountId,
        },
        incomeLeg: {
          currency: 'INCOME',
          fromAccountId: facts.incomeIssuerAccountId,
          toAccountId: facts.incomeAvailableAccountId,
        },
        incomeLot: {
          accountId: facts.incomeAvailableAccountId,
          currency: 'INCOME',
          sourceKind: 'COMMISSION_SETTLEMENT',
          originalAmount: 500,
        },
      },
    });
  });

  it.each([
    [{ ...facts, orderState: 'REQUESTED' }, 'paid'],
    [{ ...facts, paymentState: 'PENDING' }, 'paid'],
    [{ ...facts, reservationState: 'SETTLED' }, 'held'],
    [{ ...facts, reservationCurrency: 'INCOME' }, 'POINT'],
    [{ ...facts, fundingTransferAmount: 499 }, 'funded amount'],
    [{ ...facts, fundingTransferToAccountId: 999 }, 'escrow'],
    [{ ...facts, linkedReservationId: 999 }, 'Order-owned'],
    [{ ...facts, fundingCommandKind: 'SETTLE' }, 'completed PAY'],
    [{ ...facts, fundingCommandResultOperationId: null }, 'completed PAY'],
    [{ ...facts, fundingCommandPrincipalId: 999 }, 'principal'],
    [{ ...facts, fundingCommandSubjectKey: '999' }, 'payment subject'],
    [{ ...facts, reservationHolderBindingKey: '999' }, 'buyer holder'],
    [{ ...facts, reservationFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ff' }, 'flow'],
  ])('rejects invalid settlement facts', (invalidFacts, message) => {
    expect(() =>
      planCommissionSettlement(invalidFacts, {
        contractId: facts.contractId,
        actorId: facts.workerId,
        commandKey: 'settle-1',
      }),
    ).toThrow(new RegExp(message, 'i'));
  });

  it('rejects settlement by anyone except the contract worker', () => {
    expect(() =>
      planCommissionSettlement(facts, {
        contractId: facts.contractId,
        actorId: 999,
        commandKey: 'settle-1',
      }),
    ).toThrow(CommissionSettlementStateError);
  });
});
