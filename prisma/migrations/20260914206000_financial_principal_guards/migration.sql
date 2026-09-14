-- Keep principal-to-ledger bindings stable because advisory locks and financial
-- shape checks resolve users through these opaque holder identities.
CREATE FUNCTION keep_financial_holder_binding_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."bindingNamespace" IS DISTINCT FROM OLD."bindingNamespace"
    OR NEW."bindingKey" IS DISTINCT FROM OLD."bindingKey"
  ) THEN
    RAISE EXCEPTION 'FinancialHolder_binding_immutable: holder % binding is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialHolder_binding_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialHolder_binding_immutable"
BEFORE UPDATE ON "FinancialHolder"
FOR EACH ROW EXECUTE FUNCTION keep_financial_holder_binding_immutable();

CREATE FUNCTION reject_contract_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Contract_append_only: formed contract % cannot be changed', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'Contract_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Contract_append_only"
BEFORE UPDATE OR DELETE ON "Contract"
FOR EACH ROW EXECUTE FUNCTION reject_contract_mutation();

CREATE OR REPLACE FUNCTION assert_financial_swap_shape(checked_action_id UUID)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    action."operationKind" = 'SETTLE'
    AND operation."kind" = 'SETTLE'
    AND command."flowId" = action."flowId"
    AND command."resultOperationId" = operation."id"
    AND command."subjectNamespace" = 'commission-contract'
    AND command."subjectKey" = contract."id"::TEXT
    AND command."principalId" = contract."workerId"
    AND contract."flowId" = action."flowId"
    AND beneficiary."bindingNamespace" = 'user'
    AND beneficiary."bindingKey" = contract."workerId"::TEXT
    AND reservation."purpose" = 'COMMISSION_PAYMENT'
    AND reservation."currency" = 'POINT'
    AND reservation."state" = 'SETTLED'
    AND funding_action."operationKind" = 'PAY'
    AND funding_operation."kind" = 'PAY'
    AND funding_operation."flowId" = action."flowId"
    AND funding_command."kind" = 'PAY'
    AND funding_command."flowId" = action."flowId"
    AND funding_command."resultOperationId" = funding_operation."id"
    AND funding_command."principalId" = paid_order."buyerId"
    AND funding_command."subjectNamespace" = 'commission-order-payment'
    AND funding_command."subjectKey" = paid_payment."id"::TEXT
    AND payer_holder."bindingNamespace" = 'user'
    AND payer_holder."bindingKey" = paid_order."buyerId"::TEXT
    AND funding."flowId" = action."flowId"
    AND funding."currency" = 'POINT'
    AND funding."amount" = reservation."targetAmount"
    AND funding."toAccountId" = escrow."id"
    AND escrow."reservationId" = reservation."id"
    AND escrow."purpose" = 'ESCROW'
    AND paid_order."state" = 'PAID'
    AND paid_order."currency" = 'POINT'
    AND paid_order."amount" = reservation."targetAmount"
    AND paid_payment."state" = 'PAID'
    AND paid_payment."currency" = 'POINT'
    AND paid_payment."amount" = reservation."targetAmount"
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
  JOIN "FinancialCommandRun" command ON command."id" = operation."originatingCommandId"
  JOIN "Contract" contract ON contract."flowId" = action."flowId" AND contract."id"::TEXT = command."subjectKey"
  JOIN "Order" paid_order ON paid_order."id" = contract."orderId" AND paid_order."flowId" = contract."flowId"
  JOIN "OrderPayment" paid_payment ON paid_payment."orderId" = paid_order."id" AND paid_payment."flowId" = paid_order."flowId"
  JOIN "OrderFinancialLink" order_link ON order_link."orderPaymentId" = paid_payment."id" AND order_link."flowId" = paid_payment."flowId" AND order_link."reservationId" = action."reservationId"
  JOIN "FinancialHolder" beneficiary ON beneficiary."id" = action."beneficiaryHolderId"
  JOIN "FinancialReservation" reservation ON reservation."id" = action."reservationId"
  JOIN "FinancialHolder" payer_holder ON payer_holder."id" = reservation."holderId"
  JOIN "FinancialTransfer" funding ON funding."reservationId" = reservation."id"
  JOIN "FinancialTransferAction" funding_action ON funding_action."id" = funding."actionId"
  JOIN "FinancialOperation" funding_operation ON funding_operation."id" = funding_action."operationId"
  JOIN "FinancialCommandRun" funding_command ON funding_command."id" = funding_operation."originatingCommandId"
  JOIN "FinancialAccount" escrow ON escrow."id" = funding."toAccountId"
  WHERE action."id" = checked_action_id;

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialSwap_shape_check: swap % must bind the contract worker to one funded POINT reservation and one INCOME lot', checked_action_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialSwap_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_financial_withdrawal_shape(checked_withdrawal_id UUID)
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
    AND holder."bindingNamespace" = 'user'
    AND holder."bindingKey" = command."principalId"::TEXT
    AND command."subjectNamespace" = 'income-withdrawal'
    AND command."subjectKey" = withdrawal."flowId"::TEXT
    AND reservation."bindingNamespace" = 'income-withdrawal'
    AND reservation."bindingKey" = withdrawal."flowId"::TEXT
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
  JOIN "FinancialHolder" holder ON holder."id" = reservation."holderId"
  JOIN "FinancialTransfer" transfer ON transfer."reservationId" = reservation."id"
  JOIN "FinancialAccount" source ON source."id" = transfer."fromAccountId"
  JOIN "FinancialAccount" destination ON destination."id" = transfer."toAccountId"
  JOIN "FinancialCommandRun" command ON command."id" = operation."originatingCommandId"
  WHERE withdrawal."id" = checked_withdrawal_id;

  IF COALESCE(violates, TRUE) THEN
    RAISE EXCEPTION 'FinancialWithdrawal_shape_check: withdrawal % must bind its principal to one completed INCOME hold', checked_withdrawal_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;
