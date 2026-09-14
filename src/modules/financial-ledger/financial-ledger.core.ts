import { DomainError } from '../../foundation/errors.js';

export interface FinancialLotBalance {
  lotId: number;
  remainingAmount: number;
}

export interface FinancialAllocation {
  lotId: number;
  amount: number;
  assumedRemainingAmount: number;
}

export class InvalidFinancialAmountError extends DomainError {
  constructor(amount: number) {
    super(`Financial amount must be a positive integer, got ${amount}`, 'INVALID_FINANCIAL_AMOUNT');
  }
}

export class InsufficientFinancialFundsError extends DomainError {
  constructor(available: number, requested: number) {
    super(`Insufficient POINT: have ${available}, need ${requested}`, 'INSUFFICIENT_FINANCIAL_FUNDS');
  }
}

export function planReservation(
  lots: readonly FinancialLotBalance[],
  amount: number,
): FinancialAllocation[] {
  if (!Number.isInteger(amount) || amount <= 0) throw new InvalidFinancialAmountError(amount);
  let remaining = amount;
  const allocations: FinancialAllocation[] = [];
  for (const lot of lots) {
    if (remaining === 0) break;
    const allocated = Math.min(lot.remainingAmount, remaining);
    if (allocated > 0) {
      allocations.push({
        lotId: lot.lotId,
        amount: allocated,
        assumedRemainingAmount: lot.remainingAmount,
      });
      remaining -= allocated;
    }
  }
  if (remaining > 0) {
    const available = amount - remaining;
    throw new InsufficientFinancialFundsError(available, amount);
  }
  return allocations;
}
