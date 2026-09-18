-- Accounting classification is captured on the immutable lot basis so later
-- reporting does not need to reinterpret an old issuance using today's policy.
ALTER TABLE "FinancialLot"
  ADD COLUMN "issuanceReason" TEXT,
  ADD COLUMN "accountingCategory" TEXT,
  ADD COLUMN "accountingPolicyVersion" TEXT;

ALTER TABLE "FinancialLot" DROP CONSTRAINT "FinancialLot_source_check";
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_source_check" CHECK (
  (
    "currency" = 'POINT'
    AND "sourceKind" IN ('PAID', 'FREE')
    AND "sourceOperationId" IS NULL
    AND "sourceSwapActionId" IS NULL
    AND "sourceFlowId" IS NULL
    AND "sourceFlowKind" IS NULL
    AND "sourceOperationKind" IS NULL
    AND "issuanceReason" IS NULL
    AND "accountingCategory" IS NULL
    AND "accountingPolicyVersion" IS NULL
  ) OR (
    "currency" = 'POINT'
    AND "sourceKind" = 'PAID'
    AND "sourceOperationId" IS NOT NULL
    AND "sourceSwapActionId" IS NULL
    AND "sourceFlowId" IS NOT NULL
    AND "sourceFlowKind" IS NOT DISTINCT FROM 'POINT_CHARGE'
    AND "sourceOperationKind" IS NOT DISTINCT FROM 'CHARGE'
    AND "issuanceReason" IS NOT DISTINCT FROM 'PURCHASE'
    AND "accountingCategory" IS NOT DISTINCT FROM 'CUSTOMER_ADVANCE'
    AND "accountingPolicyVersion" IS NOT DISTINCT FROM 'point-charge-v1'
  ) OR (
    "currency" = 'INCOME'
    AND "sourceKind" = 'COMMISSION_SETTLEMENT'
    AND "sourceOperationId" IS NOT NULL
    AND "sourceSwapActionId" IS NOT NULL
    AND "sourceFlowId" IS NOT NULL
    AND "sourceFlowKind" IS NOT DISTINCT FROM 'COMMISSION'
    AND "sourceOperationKind" IS NOT DISTINCT FROM 'SETTLE'
    AND "issuanceReason" IS NULL
    AND "accountingCategory" IS NULL
    AND "accountingPolicyVersion" IS NULL
  )
);

CREATE UNIQUE INDEX "FinancialCommandRun_point_charge_payment_key"
ON "FinancialCommandRun" ("subjectNamespace", "subjectKey", "kind")
WHERE "flowKind" = 'POINT_CHARGE' AND "kind" = 'CHARGE';

CREATE UNIQUE INDEX "FinancialLot_point_charge_flow_key"
ON "FinancialLot" ("sourceFlowId")
WHERE "sourceFlowKind" = 'POINT_CHARGE' AND "sourceOperationKind" = 'CHARGE';

ALTER TABLE "FinancialCommandRun"
ADD CONSTRAINT "FinancialCommandRun_point_charge_kind_check" CHECK (
  "kind" <> 'CHARGE' OR "flowKind" = 'POINT_CHARGE'
);

CREATE OR REPLACE FUNCTION keep_point_lot_basis_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
    OR NEW."sourceOperationId" IS DISTINCT FROM OLD."sourceOperationId"
    OR NEW."sourceSwapActionId" IS DISTINCT FROM OLD."sourceSwapActionId"
    OR NEW."sourceFlowId" IS DISTINCT FROM OLD."sourceFlowId"
    OR NEW."sourceFlowKind" IS DISTINCT FROM OLD."sourceFlowKind"
    OR NEW."sourceOperationKind" IS DISTINCT FROM OLD."sourceOperationKind"
    OR NEW."issuanceReason" IS DISTINCT FROM OLD."issuanceReason"
    OR NEW."accountingCategory" IS DISTINCT FROM OLD."accountingCategory"
    OR NEW."accountingPolicyVersion" IS DISTINCT FROM OLD."accountingPolicyVersion"
    OR NEW."originalAmount" IS DISTINCT FROM OLD."originalAmount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'FinancialLot_basis_immutable: lot % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialLot_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_point_charge_lot_shape(checked_lot_id INTEGER)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    lot."currency" = 'POINT'
    AND lot."sourceKind" = 'PAID'
    AND lot."sourceSwapActionId" IS NULL
    AND lot."sourceFlowKind" = 'POINT_CHARGE'
    AND lot."sourceOperationKind" = 'CHARGE'
    AND lot."issuanceReason" = 'PURCHASE'
    AND lot."accountingCategory" = 'CUSTOMER_ADVANCE'
    AND lot."accountingPolicyVersion" = 'point-charge-v1'
    AND lot."originalAmount" > 0
    AND lot."remainingAmount" = lot."originalAmount"
    AND account."currency" = 'POINT'
    AND account."purpose" = 'AVAILABLE'
    AND holder."bindingNamespace" = 'user'
    AND holder."bindingKey" = command."principalId"::TEXT
    AND operation."kind" = 'CHARGE'
    AND command."flowKind" = 'POINT_CHARGE'
    AND command."kind" = 'CHARGE'
    AND command."subjectNamespace" = 'point-charge-payment'
    AND command."resultOperationId" = operation."id"
  )
  INTO violates
  FROM "FinancialLot" lot
  JOIN "FinancialAccount" account ON account."id" = lot."accountId"
  JOIN "FinancialHolder" holder ON holder."id" = account."holderId"
  JOIN "FinancialOperation" operation ON operation."id" = lot."sourceOperationId"
  JOIN "FinancialCommandRun" command ON command."id" = operation."originatingCommandId"
  WHERE lot."id" = checked_lot_id;

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialLot_point_charge_shape_check: lot % must be issued by one completed POINT_CHARGE command to its principal', checked_lot_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialLot_point_charge_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_point_charge_lot_shape()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_point_charge_lot_shape(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialLot_point_charge_shape_check"
AFTER INSERT ON "FinancialLot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."sourceOperationKind" = 'CHARGE')
EXECUTE FUNCTION check_point_charge_lot_shape();

CREATE OR REPLACE FUNCTION assert_financial_command_effect(checked_command_id UUID)
RETURNS VOID AS $$
DECLARE
  command_row RECORD;
  operation_row RECORD;
  origin_row RECORD;
  effect_exists BOOLEAN;
BEGIN
  SELECT * INTO command_row
  FROM "FinancialCommandRun"
  WHERE "id" = checked_command_id;

  IF command_row."resultOperationId" IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO operation_row
  FROM "FinancialOperation"
  WHERE "id" = command_row."resultOperationId";
  SELECT * INTO origin_row
  FROM "FinancialCommandRun"
  WHERE "id" = operation_row."originatingCommandId";

  IF command_row."id" <> origin_row."id" AND (
    command_row."flowId" IS DISTINCT FROM origin_row."flowId"
    OR command_row."kind" IS DISTINCT FROM origin_row."kind"
    OR command_row."principalId" IS DISTINCT FROM origin_row."principalId"
    OR command_row."payloadHash" IS DISTINCT FROM origin_row."payloadHash"
    OR command_row."subjectNamespace" IS DISTINCT FROM origin_row."subjectNamespace"
    OR command_row."subjectKey" IS DISTINCT FROM origin_row."subjectKey"
  ) THEN
    RAISE EXCEPTION 'FinancialCommand_effect_completeness_check: alias command % identity differs from origin', checked_command_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommand_effect_completeness_check';
  END IF;

  effect_exists := CASE command_row."kind"
    WHEN 'PAY' THEN EXISTS (
      SELECT 1
      FROM "FinancialTransferAction" action
      JOIN "FinancialTransfer" transfer ON transfer."actionId" = action."id"
      WHERE action."operationId" = operation_row."id"
        AND action."flowId" = command_row."flowId"
        AND action."operationKind" = 'PAY'
    )
    WHEN 'SETTLE' THEN EXISTS (
      SELECT 1
      FROM "FinancialSwapAction" action
      WHERE action."operationId" = operation_row."id"
        AND action."flowId" = command_row."flowId"
        AND action."operationKind" = 'SETTLE'
    )
    WHEN 'WITHDRAW' THEN EXISTS (
      SELECT 1
      FROM "FinancialWithdrawal" withdrawal
      WHERE withdrawal."operationId" = operation_row."id"
        AND withdrawal."flowId" = command_row."flowId"
        AND withdrawal."operationKind" = 'WITHDRAW'
    )
    WHEN 'CHARGE' THEN EXISTS (
      SELECT 1
      FROM "FinancialLot" lot
      JOIN "FinancialAccount" account ON account."id" = lot."accountId"
      JOIN "FinancialHolder" holder ON holder."id" = account."holderId"
      WHERE lot."sourceOperationId" = operation_row."id"
        AND lot."sourceFlowId" = command_row."flowId"
        AND lot."sourceFlowKind" = 'POINT_CHARGE'
        AND lot."sourceOperationKind" = 'CHARGE'
        AND lot."currency" = 'POINT'
        AND lot."sourceKind" = 'PAID'
        AND lot."issuanceReason" = 'PURCHASE'
        AND lot."accountingCategory" = 'CUSTOMER_ADVANCE'
        AND lot."accountingPolicyVersion" = 'point-charge-v1'
        AND lot."originalAmount" > 0
        AND lot."remainingAmount" = lot."originalAmount"
        AND account."currency" = 'POINT'
        AND account."purpose" = 'AVAILABLE'
        AND holder."bindingNamespace" = 'user'
        AND holder."bindingKey" = command_row."principalId"::TEXT
        AND command_row."flowKind" = 'POINT_CHARGE'
        AND command_row."subjectNamespace" = 'point-charge-payment'
    )
    ELSE TRUE
  END;

  IF NOT effect_exists THEN
    RAISE EXCEPTION 'FinancialCommand_effect_completeness_check: command % has no typed financial effect', checked_command_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommand_effect_completeness_check';
  END IF;
END;
$$ LANGUAGE plpgsql;
