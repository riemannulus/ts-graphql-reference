-- A completed command and a typed financial action are two sides of one audit
-- fact. Deferred reverse checks let a transaction build either side first.
CREATE FUNCTION assert_financial_command_effect(checked_command_id UUID)
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
    ELSE TRUE
  END;

  IF NOT effect_exists THEN
    RAISE EXCEPTION 'FinancialCommand_effect_completeness_check: command % has no typed financial effect', checked_command_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommand_effect_completeness_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_command_effect()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_financial_command_effect(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialCommand_effect_completeness_check"
AFTER INSERT OR UPDATE OF "resultOperationId" ON "FinancialCommandRun"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."resultOperationId" IS NOT NULL)
EXECUTE FUNCTION check_financial_command_effect();

CREATE FUNCTION assert_withdraw_action_totality(checked_action_id UUID)
RETURNS VOID AS $$
DECLARE
  action_kind "FinancialCommandKind";
BEGIN
  SELECT "operationKind" INTO action_kind
  FROM "FinancialTransferAction"
  WHERE "id" = checked_action_id;

  IF action_kind = 'WITHDRAW' AND NOT EXISTS (
    SELECT 1
    FROM "FinancialWithdrawal"
    WHERE "transferActionId" = checked_action_id
  ) THEN
    RAISE EXCEPTION 'FinancialWithdrawal_totality_check: WITHDRAW action % has no withdrawal', checked_action_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_totality_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_withdraw_action_totality()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_withdraw_action_totality(NEW."actionId");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialWithdrawal_totality_check"
AFTER INSERT ON "FinancialTransfer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_withdraw_action_totality();
