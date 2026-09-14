-- External PoC invariant guards. This repository's CONVENTIONS.md treats the
-- database as the last line of defense for append-only financial history.

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
  ) OR (
    "currency" = 'INCOME'
    AND "sourceKind" = 'COMMISSION_SETTLEMENT'
    AND "sourceOperationId" IS NOT NULL
    AND "sourceSwapActionId" IS NOT NULL
    AND "sourceFlowId" IS NOT NULL
    AND "sourceFlowKind" = 'COMMISSION'
    AND "sourceOperationKind" = 'SETTLE'
  )
);

ALTER TABLE "FinancialTransferAction" ADD CONSTRAINT "FinancialTransferAction_operation_kind_check"
  CHECK ("operationKind" IN ('PAY', 'WITHDRAW'));
ALTER TABLE "FinancialSwapAction" ADD CONSTRAINT "FinancialSwapAction_operation_kind_check"
  CHECK ("operationKind" = 'SETTLE');
ALTER TABLE "FinancialWithdrawal" ADD CONSTRAINT "FinancialWithdrawal_basis_check"
  CHECK ("flowKind" = 'WITHDRAWAL' AND "operationKind" = 'WITHDRAW');

-- The original trigger is already bound to this function name, so replace the
-- function itself when the lot basis gains new currency/provenance columns.
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
    OR NEW."originalAmount" IS DISTINCT FROM OLD."originalAmount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'FinancialLot_basis_immutable: lot % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialLot_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_financial_lot_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FinancialLot_append_only: lot % cannot be deleted', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'FinancialLot_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialLot_append_only"
BEFORE DELETE ON "FinancialLot"
FOR EACH ROW EXECUTE FUNCTION reject_financial_lot_delete();

-- A reservation starts HELD. Its sole PoC transition is a funded commission
-- reservation moving HELD -> SETTLED; every other state rewrite is rejected.
CREATE FUNCTION require_financial_reservation_initial_hold()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" <> 'HELD' THEN
    RAISE EXCEPTION 'FinancialReservation_initial_state: reservation % must start HELD', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialReservation_initial_state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialReservation_initial_state"
BEFORE INSERT ON "FinancialReservation"
FOR EACH ROW EXECUTE FUNCTION require_financial_reservation_initial_hold();

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
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    OLD."purpose" = 'COMMISSION_PAYMENT'
    AND OLD."state" = 'HELD'
    AND NEW."state" = 'SETTLED'
  ) THEN
    RAISE EXCEPTION 'FinancialReservation_state_transition: reservation % has an invalid state transition', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialReservation_state_transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_financial_swap_shape(checked_action_id UUID)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    action."operationKind" = 'SETTLE'
    AND operation."kind" = 'SETTLE'
    AND reservation."purpose" = 'COMMISSION_PAYMENT'
    AND reservation."currency" = 'POINT'
    AND reservation."state" = 'SETTLED'
    AND funding."flowId" = action."flowId"
    AND funding."currency" = 'POINT'
    AND funding."amount" = reservation."targetAmount"
    AND funding."toAccountId" = escrow."id"
    AND escrow."reservationId" = reservation."id"
    AND escrow."purpose" = 'ESCROW'
    AND (SELECT COUNT(*) FROM "FinancialSwapLeg" leg WHERE leg."actionId" = action."id") = 2
    AND EXISTS (
      SELECT 1
      FROM "FinancialSwapLeg" leg
      JOIN "FinancialAccount" destination ON destination."id" = leg."toAccountId"
      WHERE leg."actionId" = action."id"
        AND leg."currency" = 'POINT'
        AND leg."fromAccountId" = escrow."id"
        AND leg."amount" = reservation."targetAmount"
        AND destination."purpose" = 'SETTLED'
    )
    AND EXISTS (
      SELECT 1
      FROM "FinancialSwapLeg" leg
      JOIN "FinancialAccount" source ON source."id" = leg."fromAccountId"
      JOIN "FinancialAccount" destination ON destination."id" = leg."toAccountId"
      WHERE leg."actionId" = action."id"
        AND leg."currency" = 'INCOME'
        AND leg."amount" = reservation."targetAmount"
        AND source."purpose" = 'ISSUER'
        AND destination."purpose" = 'AVAILABLE'
        AND destination."holderId" = action."beneficiaryHolderId"
    )
    AND (
      SELECT point_destination."holderId"
      FROM "FinancialSwapLeg" point_leg
      JOIN "FinancialAccount" point_destination ON point_destination."id" = point_leg."toAccountId"
      WHERE point_leg."actionId" = action."id" AND point_leg."currency" = 'POINT'
    ) = (
      SELECT income_source."holderId"
      FROM "FinancialSwapLeg" income_leg
      JOIN "FinancialAccount" income_source ON income_source."id" = income_leg."fromAccountId"
      WHERE income_leg."actionId" = action."id" AND income_leg."currency" = 'INCOME'
    )
    AND EXISTS (
      SELECT 1
      FROM "FinancialHolder" platform
      WHERE platform."id" = (
        SELECT point_destination."holderId"
        FROM "FinancialSwapLeg" point_leg
        JOIN "FinancialAccount" point_destination ON point_destination."id" = point_leg."toAccountId"
        WHERE point_leg."actionId" = action."id" AND point_leg."currency" = 'POINT'
      )
        AND platform."bindingNamespace" = 'system'
        AND platform."bindingKey" = 'platform'
    )
    AND EXISTS (
      SELECT 1
      FROM "FinancialLot" lot
      JOIN "FinancialSwapLeg" income_leg
        ON income_leg."actionId" = action."id" AND income_leg."currency" = 'INCOME'
      WHERE lot."sourceSwapActionId" = action."id"
        AND lot."sourceOperationId" = operation."id"
        AND lot."sourceFlowId" = action."flowId"
        AND lot."sourceFlowKind" = 'COMMISSION'
        AND lot."sourceOperationKind" = 'SETTLE'
        AND lot."currency" = 'INCOME'
        AND lot."accountId" = income_leg."toAccountId"
        AND lot."originalAmount" = reservation."targetAmount"
        AND lot."remainingAmount" = lot."originalAmount"
    )
  )
  INTO violates
  FROM "FinancialSwapAction" action
  JOIN "FinancialOperation" operation ON operation."id" = action."operationId"
  JOIN "FinancialReservation" reservation ON reservation."id" = action."reservationId"
  JOIN "FinancialTransfer" funding ON funding."reservationId" = reservation."id"
  JOIN "FinancialAccount" escrow ON escrow."id" = funding."toAccountId"
  WHERE action."id" = checked_action_id;

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialSwap_shape_check: swap % must consume one funded POINT reservation and mint one beneficiary INCOME lot', checked_action_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialSwap_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_financial_reservation_settlement(checked_reservation_id INTEGER)
RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "FinancialSwapAction"
    WHERE "reservationId" = checked_reservation_id
  ) THEN
    RAISE EXCEPTION 'FinancialReservation_settlement_shape_check: reservation % cannot settle without a swap', checked_reservation_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialReservation_settlement_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_reservation_settlement()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."state" = 'SETTLED' THEN
    PERFORM assert_financial_reservation_settlement(NEW."id");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialReservation_settlement_shape_check"
AFTER UPDATE OF "state" ON "FinancialReservation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_financial_reservation_settlement();

CREATE FUNCTION assert_financial_withdrawal_shape(checked_withdrawal_id UUID)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    withdrawal."flowKind" = 'WITHDRAWAL'
    AND withdrawal."operationKind" = 'WITHDRAW'
    AND operation."kind" = 'WITHDRAW'
    AND action."operationKind" = 'WITHDRAW'
    AND reservation."purpose" = 'INCOME_WITHDRAWAL'
    AND reservation."currency" = 'INCOME'
    AND reservation."state" = 'HELD'
    AND transfer."actionId" = action."id"
    AND transfer."currency" = 'INCOME'
    AND transfer."amount" = reservation."targetAmount"
    AND transfer."flowId" = withdrawal."flowId"
    AND source."holderId" = reservation."holderId"
    AND source."purpose" = 'AVAILABLE'
    AND destination."reservationId" = reservation."id"
    AND destination."purpose" = 'ESCROW'
    AND command."resultOperationId" = operation."id"
  )
  INTO violates
  FROM "FinancialWithdrawal" withdrawal
  JOIN "FinancialOperation" operation ON operation."id" = withdrawal."operationId"
  JOIN "FinancialTransferAction" action ON action."id" = withdrawal."transferActionId"
  JOIN "FinancialReservation" reservation ON reservation."id" = withdrawal."reservationId"
  JOIN "FinancialTransfer" transfer ON transfer."reservationId" = reservation."id"
  JOIN "FinancialAccount" source ON source."id" = transfer."fromAccountId"
  JOIN "FinancialAccount" destination ON destination."id" = transfer."toAccountId"
  JOIN "FinancialCommandRun" command ON command."id" = operation."originatingCommandId"
  WHERE withdrawal."id" = checked_withdrawal_id;

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialWithdrawal_shape_check: withdrawal % must own one completed INCOME hold', checked_withdrawal_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_withdrawal_row()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_financial_withdrawal_shape(COALESCE(NEW."id", OLD."id"));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialWithdrawal_shape_check"
AFTER INSERT ON "FinancialWithdrawal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_financial_withdrawal_row();

CREATE OR REPLACE FUNCTION keep_financial_withdrawal_basis_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FinancialWithdrawal_append_only: withdrawal % cannot be deleted', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_append_only';
  END IF;
  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."flowKind" IS DISTINCT FROM OLD."flowKind"
    OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
    OR NEW."operationKind" IS DISTINCT FROM OLD."operationKind"
    OR NEW."transferActionId" IS DISTINCT FROM OLD."transferActionId"
    OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'FinancialWithdrawal_basis_immutable: withdrawal % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "FinancialWithdrawal_basis_immutable" ON "FinancialWithdrawal";
CREATE TRIGGER "FinancialWithdrawal_basis_immutable"
BEFORE UPDATE OR DELETE ON "FinancialWithdrawal"
FOR EACH ROW EXECUTE FUNCTION keep_financial_withdrawal_basis_immutable();
