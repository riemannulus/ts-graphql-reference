import { describe, expect, it } from 'vitest';
import {
  formatCommandId,
  formatOperationId,
  formatTransactionReference,
} from '../../../modules/transaction-flow/transaction-flow.core.js';

const id = '01995c47-d1cb-7f11-a2bd-a954bbd828ec';

describe('typed transaction-flow identifiers', () => {
  it('derives semantic public ids from the persisted kind and opaque id', () => {
    expect(formatTransactionReference({ kind: 'COMMISSION', id })).toBe(`COMMISSION-${id}`);
    expect(formatCommandId({ kind: 'PAY', id })).toBe(`CMD-PAY-${id}`);
    expect(formatOperationId({ kind: 'PAY', id })).toBe(`OP-PAY-${id}`);
    expect(formatTransactionReference({ kind: 'WITHDRAWAL', id })).toBe(`WITHDRAWAL-${id}`);
    expect(formatCommandId({ kind: 'WITHDRAW', id })).toBe(`CMD-WITHDRAW-${id}`);
    expect(formatOperationId({ kind: 'SETTLE', id })).toBe(`OP-SETTLE-${id}`);
  });
});
