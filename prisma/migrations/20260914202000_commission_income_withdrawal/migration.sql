-- Fresh-only PoC extension: commission POINT settlement into withdrawable INCOME.

ALTER TABLE "FinancialReservation" DROP CONSTRAINT "FinancialReservation_purpose_check";
ALTER TABLE "FinancialReservation" DROP CONSTRAINT "FinancialReservation_currency_check";
ALTER TABLE "FinancialReservation" DROP CONSTRAINT "FinancialReservation_state_check";
ALTER TABLE "FinancialReservation" ADD CONSTRAINT "FinancialReservation_purpose_currency_check" CHECK (
  ("purpose" = 'COMMISSION_PAYMENT' AND "currency" = 'POINT') OR
  ("purpose" = 'INCOME_WITHDRAWAL' AND "currency" = 'INCOME')
);
ALTER TABLE "FinancialReservation" ADD CONSTRAINT "FinancialReservation_state_check" CHECK ("state" IN ('HELD', 'SETTLED'));

ALTER TABLE "FinancialAccount" DROP CONSTRAINT "FinancialAccount_owner_check";
ALTER TABLE "FinancialAccount" DROP CONSTRAINT "FinancialAccount_currency_check";
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_owner_check" CHECK (
  ("purpose" IN ('AVAILABLE', 'SETTLED', 'ISSUER') AND "holderId" IS NOT NULL AND "reservationId" IS NULL) OR
  ("purpose" = 'ESCROW' AND "holderId" IS NULL AND "reservationId" IS NOT NULL)
);
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_currency_check" CHECK ("currency" IN ('POINT', 'INCOME'));
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_id_currency_key" UNIQUE ("id", "currency");

ALTER TABLE "FinancialLot" DROP CONSTRAINT "FinancialLot_accountId_fkey";
ALTER TABLE "FinancialLot" DROP CONSTRAINT "FinancialLot_sourceKind_check";
ALTER TABLE "FinancialLot"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'POINT',
  ADD COLUMN "sourceOperationId" UUID,
  ADD COLUMN "sourceFlowId" UUID,
  ADD COLUMN "sourceOperationKind" "FinancialCommandKind";
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_source_check" CHECK (
  (
    "currency" = 'POINT'
    AND "sourceKind" IN ('PAID', 'FREE')
    AND "sourceOperationId" IS NULL
    AND "sourceFlowId" IS NULL
    AND "sourceOperationKind" IS NULL
  ) OR (
    "currency" = 'INCOME'
    AND "sourceKind" = 'COMMISSION_SETTLEMENT'
    AND "sourceOperationId" IS NOT NULL
    AND "sourceFlowId" IS NOT NULL
    AND "sourceOperationKind" = 'SETTLE'
  )
);
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_accountId_currency_fkey"
  FOREIGN KEY ("accountId", "currency") REFERENCES "FinancialAccount"("id", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_sourceOperationId_sourceFlowId_sourceOperationKind_fkey"
  FOREIGN KEY ("sourceOperationId", "sourceFlowId", "sourceOperationKind")
  REFERENCES "FinancialOperation"("id", "flowId", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "FinancialLot_id_accountId_currency_key" ON "FinancialLot"("id", "accountId", "currency");
CREATE UNIQUE INDEX "FinancialLot_sourceOperationId_key" ON "FinancialLot"("sourceOperationId");

ALTER TABLE "FinancialTransfer" DROP CONSTRAINT "FinancialTransfer_fromAccountId_fkey";
ALTER TABLE "FinancialTransfer" DROP CONSTRAINT "FinancialTransfer_toAccountId_fkey";
ALTER TABLE "FinancialTransfer" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'POINT';
ALTER TABLE "FinancialTransfer" ADD CONSTRAINT "FinancialTransfer_fromAccountId_currency_fkey"
  FOREIGN KEY ("fromAccountId", "currency") REFERENCES "FinancialAccount"("id", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "FinancialTransfer" ADD CONSTRAINT "FinancialTransfer_toAccountId_currency_fkey"
  FOREIGN KEY ("toAccountId", "currency") REFERENCES "FinancialAccount"("id", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "FinancialTransfer_id_fromAccountId_currency_key" ON "FinancialTransfer"("id", "fromAccountId", "currency");

ALTER TABLE "FinancialTransferAllocation" DROP CONSTRAINT "FinancialTransferAllocation_transferId_fkey";
ALTER TABLE "FinancialTransferAllocation" DROP CONSTRAINT "FinancialTransferAllocation_lotId_fkey";
ALTER TABLE "FinancialTransferAllocation"
  ADD COLUMN "fromAccountId" INTEGER NOT NULL,
  ADD COLUMN "currency" TEXT NOT NULL;
ALTER TABLE "FinancialTransferAllocation" ADD CONSTRAINT "FinancialTransferAllocation_transfer_source_currency_fkey"
  FOREIGN KEY ("transferId", "fromAccountId", "currency")
  REFERENCES "FinancialTransfer"("id", "fromAccountId", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "FinancialTransferAllocation" ADD CONSTRAINT "FinancialTransferAllocation_lot_source_currency_fkey"
  FOREIGN KEY ("lotId", "fromAccountId", "currency")
  REFERENCES "FinancialLot"("id", "accountId", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "FinancialSwapAction" (
  "id" UUID NOT NULL,
  "flowId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "reservationId" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialSwapAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialSwapAction_operationId_key" UNIQUE ("operationId"),
  CONSTRAINT "FinancialSwapAction_reservationId_key" UNIQUE ("reservationId"),
  CONSTRAINT "FinancialSwapAction_id_flowId_key" UNIQUE ("id", "flowId"),
  CONSTRAINT "FinancialSwapAction_operationId_flowId_key" UNIQUE ("operationId", "flowId"),
  CONSTRAINT "FinancialSwapAction_reservationId_flowId_key" UNIQUE ("reservationId", "flowId"),
  CONSTRAINT "FinancialSwapAction_operationId_flowId_fkey" FOREIGN KEY ("operationId", "flowId")
    REFERENCES "FinancialOperation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FinancialSwapAction_reservationId_flowId_fkey" FOREIGN KEY ("reservationId", "flowId")
    REFERENCES "FinancialReservation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE TABLE "FinancialSwapLeg" (
  "id" SERIAL NOT NULL,
  "actionId" UUID NOT NULL,
  "flowId" UUID NOT NULL,
  "currency" TEXT NOT NULL,
  "fromAccountId" INTEGER NOT NULL,
  "toAccountId" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialSwapLeg_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialSwapLeg_actionId_currency_key" UNIQUE ("actionId", "currency"),
  CONSTRAINT "FinancialSwapLeg_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "FinancialSwapLeg_currency_check" CHECK ("currency" IN ('POINT', 'INCOME')),
  CONSTRAINT "FinancialSwapLeg_accounts_check" CHECK ("fromAccountId" <> "toAccountId"),
  CONSTRAINT "FinancialSwapLeg_actionId_flowId_fkey" FOREIGN KEY ("actionId", "flowId")
    REFERENCES "FinancialSwapAction"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FinancialSwapLeg_fromAccountId_currency_fkey" FOREIGN KEY ("fromAccountId", "currency")
    REFERENCES "FinancialAccount"("id", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FinancialSwapLeg_toAccountId_currency_fkey" FOREIGN KEY ("toAccountId", "currency")
    REFERENCES "FinancialAccount"("id", "currency") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "FinancialSwapLeg_flowId_idx" ON "FinancialSwapLeg"("flowId");

CREATE TABLE "FinancialWithdrawal" (
  "id" UUID NOT NULL,
  "flowId" UUID NOT NULL,
  "flowKind" "TransactionFlowKind" NOT NULL DEFAULT 'WITHDRAWAL',
  "holderId" INTEGER NOT NULL,
  "reservationId" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INCOME',
  "state" TEXT NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialWithdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialWithdrawal_flowId_key" UNIQUE ("flowId"),
  CONSTRAINT "FinancialWithdrawal_reservationId_key" UNIQUE ("reservationId"),
  CONSTRAINT "FinancialWithdrawal_id_flowId_key" UNIQUE ("id", "flowId"),
  CONSTRAINT "FinancialWithdrawal_reservationId_flowId_key" UNIQUE ("reservationId", "flowId"),
  CONSTRAINT "FinancialWithdrawal_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "FinancialWithdrawal_basis_check" CHECK ("flowKind" = 'WITHDRAWAL' AND "currency" = 'INCOME' AND "state" = 'HELD'),
  CONSTRAINT "FinancialWithdrawal_flowId_flowKind_fkey" FOREIGN KEY ("flowId", "flowKind")
    REFERENCES "TransactionFlow"("id", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FinancialWithdrawal_holderId_fkey" FOREIGN KEY ("holderId")
    REFERENCES "FinancialHolder"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FinancialWithdrawal_reservationId_flowId_fkey" FOREIGN KEY ("reservationId", "flowId")
    REFERENCES "FinancialReservation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE INDEX "FinancialWithdrawal_holderId_state_idx" ON "FinancialWithdrawal"("holderId", "state");

CREATE OR REPLACE FUNCTION keep_financial_lot_basis_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."accountId" IS DISTINCT FROM OLD."accountId"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."sourceKind" IS DISTINCT FROM OLD."sourceKind"
    OR NEW."sourceOperationId" IS DISTINCT FROM OLD."sourceOperationId"
    OR NEW."sourceFlowId" IS DISTINCT FROM OLD."sourceFlowId"
    OR NEW."sourceOperationKind" IS DISTINCT FROM OLD."sourceOperationKind"
    OR NEW."originalAmount" IS DISTINCT FROM OLD."originalAmount"
  ) THEN
    RAISE EXCEPTION 'FinancialLot_basis_immutable: lot % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialLot_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
  LEFT JOIN "FinancialTransferAllocation" allocation ON allocation."transferId" = transfer."id"
  LEFT JOIN "FinancialLot" lot ON lot."id" = allocation."lotId"
  WHERE transfer."id" = checked_transfer_id
  GROUP BY transfer."id", reservation."id", source."id", destination."id";

  IF violates THEN
    RAISE EXCEPTION 'FinancialTransfer_conservation_check: transfer % violates conservation', checked_transfer_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialTransfer_conservation_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_financial_swap_shape(checked_action_id UUID)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    operation."kind" = 'SETTLE'
    AND reservation."currency" = 'POINT'
    AND reservation."state" = 'SETTLED'
    AND COUNT(leg.*) = 2
    AND COUNT(leg.*) FILTER (WHERE leg."currency" = 'POINT') = 1
    AND COUNT(leg.*) FILTER (WHERE leg."currency" = 'INCOME') = 1
    AND MIN(leg."amount") = MAX(leg."amount")
    AND BOOL_AND(
      CASE leg."currency"
        WHEN 'POINT' THEN source."reservationId" = reservation."id" AND source."purpose" = 'ESCROW' AND destination."purpose" = 'SETTLED'
        WHEN 'INCOME' THEN source."purpose" = 'ISSUER' AND destination."purpose" = 'AVAILABLE'
        ELSE FALSE
      END
    )
    AND COUNT(DISTINCT lot."id") = 1
    AND BOOL_AND(
      lot."currency" = 'INCOME'
      AND lot."sourceOperationId" = operation."id"
      AND lot."sourceFlowId" = action."flowId"
      AND lot."sourceOperationKind" = 'SETTLE'
      AND lot."originalAmount" = leg."amount"
      AND lot."remainingAmount" = lot."originalAmount"
    ) FILTER (WHERE lot."id" IS NOT NULL)
  )
  INTO violates
  FROM "FinancialSwapAction" action
  JOIN "FinancialOperation" operation ON operation."id" = action."operationId"
  JOIN "FinancialReservation" reservation ON reservation."id" = action."reservationId"
  LEFT JOIN "FinancialSwapLeg" leg ON leg."actionId" = action."id"
  LEFT JOIN "FinancialAccount" source ON source."id" = leg."fromAccountId"
  LEFT JOIN "FinancialAccount" destination ON destination."id" = leg."toAccountId"
  LEFT JOIN "FinancialLot" lot ON lot."sourceOperationId" = operation."id"
  WHERE action."id" = checked_action_id
  GROUP BY action."id", operation."id", reservation."id";

  IF violates THEN
    RAISE EXCEPTION 'FinancialSwap_shape_check: swap % must conserve one POINT and one INCOME leg with one sourced lot', checked_action_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialSwap_shape_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_swap_row()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_financial_swap_shape(COALESCE(NEW."id", OLD."id"));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialSwap_shape_check"
AFTER INSERT ON "FinancialSwapAction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_financial_swap_row();

CREATE FUNCTION reject_financial_swap_action_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FinancialSwapAction_append_only: swap action % cannot be changed', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'FinancialSwapAction_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialSwapAction_append_only"
BEFORE UPDATE OR DELETE ON "FinancialSwapAction"
FOR EACH ROW EXECUTE FUNCTION reject_financial_swap_action_mutation();

CREATE FUNCTION reject_financial_swap_leg_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FinancialSwapLeg_append_only: swap leg % cannot be changed', OLD."id"
    USING ERRCODE = '23514', CONSTRAINT = 'FinancialSwapLeg_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialSwapLeg_append_only"
BEFORE UPDATE OR DELETE ON "FinancialSwapLeg"
FOR EACH ROW EXECUTE FUNCTION reject_financial_swap_leg_mutation();

CREATE FUNCTION keep_financial_withdrawal_basis_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."flowId" IS DISTINCT FROM OLD."flowId"
    OR NEW."flowKind" IS DISTINCT FROM OLD."flowKind"
    OR NEW."holderId" IS DISTINCT FROM OLD."holderId"
    OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'FinancialWithdrawal_basis_immutable: withdrawal % basis is immutable', OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialWithdrawal_basis_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialWithdrawal_basis_immutable"
BEFORE UPDATE ON "FinancialWithdrawal"
FOR EACH ROW EXECUTE FUNCTION keep_financial_withdrawal_basis_immutable();
