-- A transfer is a committed economic effect only when its originating command
-- points back to the same operation as its result. Defer the reverse check so
-- services may build rows in either order inside one transaction.
CREATE FUNCTION assert_financial_transfer_command_completion(checked_transfer_id INTEGER)
RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "FinancialTransfer" transfer
    JOIN "FinancialTransferAction" action ON action."id" = transfer."actionId"
    JOIN "FinancialOperation" operation ON operation."id" = action."operationId"
    JOIN "FinancialCommandRun" command ON command."id" = operation."originatingCommandId"
    WHERE transfer."id" = checked_transfer_id
      AND command."flowId" = transfer."flowId"
      AND command."kind" = operation."kind"
      AND command."resultOperationId" = operation."id"
  ) THEN
    RAISE EXCEPTION 'FinancialTransfer_command_completion_check: transfer % has no completed originating command', checked_transfer_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialTransfer_command_completion_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_transfer_command_completion()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_financial_transfer_command_completion(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialTransfer_command_completion_check"
AFTER INSERT ON "FinancialTransfer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_financial_transfer_command_completion();
