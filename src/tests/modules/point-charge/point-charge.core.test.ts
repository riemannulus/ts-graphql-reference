import { describe, expect, it } from 'vitest';
import {
  planPointCharge,
  planPointChargeCommand,
  planPointChargeStart,
  identifyPointChargeFundingSources,
  PointChargeStateError,
} from '../../../modules/point-charge/point-charge.core.js';

const input = {
  actorId: 7,
  amount: 500,
  externalPaymentId: 'pg-payment-101',
  commandKey: 'charge-101',
};

describe('planPointCharge', () => {
  it('plans one provenance-backed paid POINT lot', () => {
    expect(
      planPointCharge({ holderId: 11, availableAccountId: 13 }, input),
    ).toEqual({
      flowRequest: { kind: 'POINT_CHARGE', allowedCommands: ['CHARGE'] },
      commandRequest: {
        flowKind: 'POINT_CHARGE',
        kind: 'CHARGE',
        principalId: 7,
        idempotencyKey: 'charge-101',
        subjectNamespace: 'point-charge-payment',
        subjectKey: 'pg-payment-101',
      },
      operationRequest: { kind: 'CHARGE' },
      lotRequest: {
        holderId: 11,
        accountId: 13,
        currency: 'POINT',
        sourceKind: 'PAID',
        issuanceReason: 'PURCHASE',
        accountingCategory: 'CUSTOMER_ADVANCE',
        accountingPolicyVersion: 'point-charge-v1',
        amount: 500,
      },
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => planPointCharge({ holderId: 11, availableAccountId: 13 }, {
        ...input,
        amount,
      })).toThrow(PointChargeStateError);
    },
  );
});

describe('identifyPointChargeFundingSources', () => {
  const allocation = {
    lotId: 31,
    amount: 120,
    sourceFlowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    sourceFlowKind: 'POINT_CHARGE',
    sourceOperationId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
    sourceOperationKind: 'CHARGE',
    issuanceReason: 'PURCHASE',
    accountingCategory: 'CUSTOMER_ADVANCE',
    accountingPolicyVersion: 'point-charge-v1',
  };

  it('preserves exact lot and operation identity for accounting', () => {
    expect(identifyPointChargeFundingSources([allocation])).toEqual([
      {
        lotId: allocation.lotId,
        operationId: allocation.sourceOperationId,
        flowId: allocation.sourceFlowId,
        amount: allocation.amount,
        issuanceReason: allocation.issuanceReason,
        accountingCategory: allocation.accountingCategory,
        accountingPolicyVersion: allocation.accountingPolicyVersion,
      },
    ]);
  });

  it.each(['sourceFlowId', 'sourceOperationId', 'accountingCategory'] as const)(
    'rejects missing %s instead of guessing provenance',
    (field) => {
      expect(() => identifyPointChargeFundingSources([{ ...allocation, [field]: null }])).toThrow(
        PointChargeStateError,
      );
    },
  );
});

describe('planPointChargeStart', () => {
  const requested = {
    ...planPointChargeCommand(input),
    payloadHash: 'payload-a',
  };
  const completed = {
    flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    ...requested,
    operationDbId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
    operationId: 'OP-CHARGE-01995c47-d1cb-7f11-a2bd-a954bbd828ed',
    referenceId: 'POINT_CHARGE-01995c47-d1cb-7f11-a2bd-a954bbd828ec',
    commandId: 'CMD-CHARGE-01995c47-d1cb-7f11-a2bd-a954bbd828ee',
  };

  it('replays the completed charge found by payment subject', () => {
    expect(planPointChargeStart(null, completed, requested)).toEqual({
      kind: 'REPLAY',
      identity: completed,
    });
  });

  it('proceeds when neither command key nor payment was used', () => {
    expect(planPointChargeStart(null, null, requested)).toEqual({ kind: 'PROCEED' });
  });

  it('rejects a reused command key or payment with different identity', () => {
    expect(() =>
      planPointChargeStart({ ...completed, payloadHash: 'payload-b' }, null, requested),
    ).toThrow(PointChargeStateError);
    expect(() =>
      planPointChargeStart(null, { ...completed, subjectKey: 'another-payment' }, requested),
    ).toThrow(PointChargeStateError);
  });
});
