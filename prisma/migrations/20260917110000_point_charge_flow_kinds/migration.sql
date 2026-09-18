-- Enum values commit before the following migration uses them in constraints.
ALTER TYPE "TransactionFlowKind" ADD VALUE 'POINT_CHARGE';
ALTER TYPE "FinancialCommandKind" ADD VALUE 'CHARGE';
