import { describe, expect, it } from 'vitest';
import {
  assertIncomeWithdrawalReplay,
  IncomeWithdrawalAmountError,
  planIncomeWithdrawal,
} from '../../../modules/income-withdrawal/income-withdrawal.core.js';

describe('planIncomeWithdrawal', () => {
  it('allocates INCOME FIFO across commission-sourced lots', () => {
    expect(
      planIncomeWithdrawal(
        {
          holderId: 10,
          availableAccountId: 20,
          lots: [
            { lotId: 1, remainingAmount: 30 },
            { lotId: 2, remainingAmount: 50 },
          ],
        },
        { actorId: 7, amount: 60, commandKey: 'withdraw-1' },
      ),
    ).toEqual({
      flowRequest: { kind: 'WITHDRAWAL', allowedCommands: ['WITHDRAW'] },
      commandRequest: {
        flowKind: 'WITHDRAWAL',
        kind: 'WITHDRAW',
        principalId: 7,
        idempotencyKey: 'withdraw-1',
        subjectNamespace: 'income-withdrawal',
        subjectKey: { source: 'FLOW_ID' },
      },
      operationRequest: { kind: 'WITHDRAW', actionKind: 'TRANSFER' },
      reservationRequest: {
        bindingNamespace: 'income-withdrawal',
        bindingKey: { source: 'FLOW_ID' },
        holderId: 10,
        purpose: 'INCOME_WITHDRAWAL',
        currency: 'INCOME',
        amount: 60,
        escrowAccount: { purpose: 'ESCROW', currency: 'INCOME' },
        transfer: {
          currency: 'INCOME',
          amount: 60,
          fromAccountId: 20,
          allocations: [
            { lotId: 1, assumedRemainingAmount: 30, amount: 30 },
            { lotId: 2, assumedRemainingAmount: 50, amount: 30 },
          ],
        },
      },
      withdrawalRequest: { flowKind: 'WITHDRAWAL' },
    });
  });

  it('rejects zero and negative withdrawal amounts', () => {
    const world = { holderId: 10, availableAccountId: 20, lots: [] };
    expect(() =>
      planIncomeWithdrawal(world, { actorId: 7, amount: 0, commandKey: 'zero' }),
    ).toThrow(IncomeWithdrawalAmountError);
    expect(() =>
      planIncomeWithdrawal(world, { actorId: 7, amount: -1, commandKey: 'negative' }),
    ).toThrow(IncomeWithdrawalAmountError);
  });

  it('rejects a withdrawal larger than available INCOME', () => {
    expect(() =>
      planIncomeWithdrawal(
        { holderId: 10, availableAccountId: 20, lots: [{ lotId: 1, remainingAmount: 20 }] },
        { actorId: 7, amount: 21, commandKey: 'too-large' },
      ),
    ).toThrow(/Insufficient INCOME/);
  });

  it('validates replay identity and requires a completed operation', () => {
    const stored = {
      flowId: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      flowKind: 'WITHDRAWAL',
      kind: 'WITHDRAW',
      payloadHash: 'same',
      subjectNamespace: 'income-withdrawal',
      subjectKey: '01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      operationDbId: '01995c47-d1cb-7f11-a2bd-a954bbd828ed',
      referenceId: 'WITHDRAWAL-01995c47-d1cb-7f11-a2bd-a954bbd828ec',
      commandId: 'CMD-WITHDRAW-01995c47-d1cb-7f11-a2bd-a954bbd828ee',
      operationId: 'OP-WITHDRAW-01995c47-d1cb-7f11-a2bd-a954bbd828ed',
    } as const;

    expect(assertIncomeWithdrawalReplay(stored, 'same')).toEqual(stored);
    expect(() => assertIncomeWithdrawalReplay({ ...stored, payloadHash: 'other' }, 'same')).toThrow(
      /identity mismatch/,
    );
    expect(() => assertIncomeWithdrawalReplay({ ...stored, operationDbId: null }, 'same')).toThrow(
      /completed operation/,
    );
  });
});
