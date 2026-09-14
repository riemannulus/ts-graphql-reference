-- Financial identity is audit history: only the command result link has one
-- legal transition (NULL -> operation id). Everything else is append-only.
CREATE FUNCTION enforce_financial_command_immutability()
RETURNS TRIGGER AS $$
DECLARE
  originated_operation_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FinancialCommandRun_append_only: command % cannot be deleted', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommandRun_append_only';
  END IF;

  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."flowKind" IS DISTINCT FROM OLD."flowKind"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."principalId" IS DISTINCT FROM OLD."principalId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
    OR NEW."subjectNamespace" IS DISTINCT FROM OLD."subjectNamespace"
    OR NEW."subjectKey" IS DISTINCT FROM OLD."subjectKey"
    OR OLD."resultOperationId" IS NOT NULL
    OR NEW."resultOperationId" IS NULL
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'FinancialCommandRun_append_only: command % identity or result cannot be changed', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommandRun_append_only';
  END IF;

  SELECT "id" INTO originated_operation_id
  FROM "FinancialOperation"
  WHERE "originatingCommandId" = OLD."id";

  IF originated_operation_id IS NULL OR NEW."resultOperationId" <> originated_operation_id THEN
    RAISE EXCEPTION 'FinancialCommandRun_result_origin_mismatch: command % must return its originated operation', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialCommandRun_result_origin_mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialCommandRun_append_only"
BEFORE UPDATE OR DELETE ON "FinancialCommandRun"
FOR EACH ROW EXECUTE FUNCTION enforce_financial_command_immutability();

CREATE FUNCTION enforce_financial_operation_origin()
RETURNS TRIGGER AS $$
DECLARE
  existing_result_id UUID;
BEGIN
  SELECT "resultOperationId" INTO existing_result_id
  FROM "FinancialCommandRun"
  WHERE "id" = NEW."originatingCommandId";

  IF existing_result_id IS NOT NULL THEN
    RAISE EXCEPTION 'FinancialOperation_alias_origin: command % already aliases operation %', NEW."originatingCommandId", existing_result_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialOperation_alias_origin';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialOperation_origin_guard"
BEFORE INSERT ON "FinancialOperation"
FOR EACH ROW EXECUTE FUNCTION enforce_financial_operation_origin();

CREATE FUNCTION reject_financial_operation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FinancialOperation_append_only: operation % cannot be changed', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'FinancialOperation_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialOperation_append_only"
BEFORE UPDATE OR DELETE ON "FinancialOperation"
FOR EACH ROW EXECUTE FUNCTION reject_financial_operation_mutation();

CREATE FUNCTION reject_financial_transfer_action_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FinancialTransferAction_append_only: action % cannot be changed', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'FinancialTransferAction_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialTransferAction_append_only"
BEFORE UPDATE OR DELETE ON "FinancialTransferAction"
FOR EACH ROW EXECUTE FUNCTION reject_financial_transfer_action_mutation();

CREATE FUNCTION keep_order_flow_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."flowId" IS DISTINCT FROM OLD."flowId" THEN
    RAISE EXCEPTION 'Order_flow_immutable: order % flow cannot be changed', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'Order_flow_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Order_flow_immutable"
BEFORE UPDATE ON "Order"
FOR EACH ROW EXECUTE FUNCTION keep_order_flow_immutable();

CREATE OR REPLACE FUNCTION keep_financial_reservation_basis_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."referenceId" IS DISTINCT FROM OLD."referenceId"
    OR NEW."bindingNamespace" IS DISTINCT FROM OLD."bindingNamespace"
    OR NEW."bindingKey" IS DISTINCT FROM OLD."bindingKey"
    OR NEW."holderId" IS DISTINCT FROM OLD."holderId"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."targetAmount" IS DISTINCT FROM OLD."targetAmount"
  ) THEN
    RAISE EXCEPTION 'FinancialReservation_basis_immutable: reservation % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialReservation_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
