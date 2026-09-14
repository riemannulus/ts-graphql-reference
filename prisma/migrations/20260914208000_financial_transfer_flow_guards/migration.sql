-- A reservation purpose is part of the effect type. Bind it to the flow and
-- command kind so a raw writer cannot disguise a withdrawal as a PAY effect.
CREATE OR REPLACE FUNCTION assert_financial_transfer_conservation(checked_transfer_id INTEGER)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    transfer."amount" = reservation."targetAmount"
    AND transfer."currency" = reservation."currency"
    AND source."holderId" = reservation."holderId"
    AND source."purpose" = 'AVAILABLE'
    AND destination."reservationId" = reservation."id"
    AND destination."purpose" = 'ESCROW'
    AND action."operationKind" = operation."kind"
    AND operation."flowId" = transfer."flowId"
    AND flow."id" = transfer."flowId"
    AND (
      (
        reservation."purpose" = 'COMMISSION_PAYMENT'
        AND reservation."currency" = 'POINT'
        AND flow."kind" = 'COMMISSION'
        AND operation."kind" = 'PAY'
      ) OR (
        reservation."purpose" = 'INCOME_WITHDRAWAL'
        AND reservation."currency" = 'INCOME'
        AND flow."kind" = 'WITHDRAWAL'
        AND operation."kind" = 'WITHDRAW'
      )
    )
    AND COUNT(allocation.*) > 0
    AND COALESCE(SUM(allocation."amount"), 0) = transfer."amount"
    AND BOOL_AND(
      allocation."fromAccountId" = transfer."fromAccountId"
      AND allocation."currency" = transfer."currency"
      AND lot."accountId" = transfer."fromAccountId"
      AND lot."currency" = transfer."currency"
    )
  )
  INTO violates
  FROM "FinancialTransfer" transfer
  JOIN "FinancialReservation" reservation ON reservation."id" = transfer."reservationId"
  JOIN "FinancialAccount" source ON source."id" = transfer."fromAccountId"
  JOIN "FinancialAccount" destination ON destination."id" = transfer."toAccountId"
  JOIN "FinancialTransferAction" action ON action."id" = transfer."actionId"
  JOIN "FinancialOperation" operation ON operation."id" = action."operationId"
  JOIN "TransactionFlow" flow ON flow."id" = transfer."flowId"
  LEFT JOIN "FinancialTransferAllocation" allocation ON allocation."transferId" = transfer."id"
  LEFT JOIN "FinancialLot" lot ON lot."id" = allocation."lotId"
  WHERE transfer."id" = checked_transfer_id
  GROUP BY transfer."id", reservation."id", source."id", destination."id", action."id", operation."id", flow."id";

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialTransfer_conservation_check: transfer % violates conservation or purpose/flow/command typing', checked_transfer_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialTransfer_conservation_check';
  END IF;
END;
$$ LANGUAGE plpgsql;
