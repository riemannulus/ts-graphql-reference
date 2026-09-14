-- PROTOTYPE: initial checkout, generic financial reservation, and Contract formation.
CREATE TABLE "CommissionType" (
  "id" SERIAL PRIMARY KEY,
  "workerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "title" TEXT NOT NULL,
  "price" INTEGER NOT NULL,
  CONSTRAINT "CommissionType_price_check" CHECK ("price" > 0)
);
CREATE INDEX "CommissionType_workerId_idx" ON "CommissionType"("workerId");

CREATE TABLE "CommissionSlot" (
  "id" SERIAL PRIMARY KEY,
  "workerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE',
  CONSTRAINT "CommissionSlot_state_check" CHECK ("state" IN ('AVAILABLE', 'OCCUPIED'))
);
CREATE INDEX "CommissionSlot_workerId_state_idx" ON "CommissionSlot"("workerId", "state");

CREATE TABLE "FinancialHolder" (
  "id" SERIAL PRIMARY KEY,
  "bindingNamespace" TEXT NOT NULL,
  "bindingKey" TEXT NOT NULL,
  CONSTRAINT "FinancialHolder_bindingNamespace_bindingKey_key" UNIQUE ("bindingNamespace", "bindingKey")
);

CREATE TABLE "FinancialReservation" (
  "id" SERIAL PRIMARY KEY,
  "referenceId" TEXT NOT NULL,
  "bindingNamespace" TEXT NOT NULL,
  "bindingKey" TEXT NOT NULL,
  "holderId" INTEGER NOT NULL REFERENCES "FinancialHolder"("id") ON DELETE RESTRICT,
  "purpose" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "targetAmount" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialReservation_referenceId_key" UNIQUE ("referenceId"),
  CONSTRAINT "FinancialReservation_bindingNamespace_bindingKey_key" UNIQUE ("bindingNamespace", "bindingKey"),
  CONSTRAINT "FinancialReservation_purpose_check" CHECK ("purpose" = 'COMMISSION_PAYMENT'),
  CONSTRAINT "FinancialReservation_currency_check" CHECK ("currency" = 'POINT'),
  CONSTRAINT "FinancialReservation_targetAmount_check" CHECK ("targetAmount" > 0),
  CONSTRAINT "FinancialReservation_state_check" CHECK ("state" = 'HELD')
);
CREATE INDEX "FinancialReservation_holderId_state_idx" ON "FinancialReservation"("holderId", "state");

CREATE TABLE "FinancialAccount" (
  "id" SERIAL PRIMARY KEY,
  "currency" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "holderId" INTEGER REFERENCES "FinancialHolder"("id") ON DELETE RESTRICT,
  "reservationId" INTEGER UNIQUE REFERENCES "FinancialReservation"("id") ON DELETE RESTRICT,
  CONSTRAINT "FinancialAccount_owner_check" CHECK (
    ("purpose" = 'AVAILABLE' AND "holderId" IS NOT NULL AND "reservationId" IS NULL) OR
    ("purpose" = 'ESCROW' AND "holderId" IS NULL AND "reservationId" IS NOT NULL)
  ),
  CONSTRAINT "FinancialAccount_currency_check" CHECK ("currency" = 'POINT'),
  CONSTRAINT "FinancialAccount_holderId_currency_purpose_key" UNIQUE ("holderId", "currency", "purpose")
);

CREATE TABLE "PointLot" (
  "id" SERIAL PRIMARY KEY,
  "accountId" INTEGER NOT NULL REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT,
  "sourceKind" TEXT NOT NULL,
  "originalAmount" INTEGER NOT NULL,
  "remainingAmount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointLot_sourceKind_check" CHECK ("sourceKind" IN ('PAID', 'FREE')),
  CONSTRAINT "PointLot_originalAmount_check" CHECK ("originalAmount" > 0),
  CONSTRAINT "PointLot_remainingAmount_check" CHECK ("remainingAmount" >= 0 AND "remainingAmount" <= "originalAmount")
);
CREATE INDEX "PointLot_accountId_createdAt_id_idx" ON "PointLot"("accountId", "createdAt", "id");

CREATE TABLE "Order" (
  "id" SERIAL PRIMARY KEY,
  "buyerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "commissionTypeId" INTEGER NOT NULL REFERENCES "CommissionType"("id") ON DELETE RESTRICT,
  "slotId" INTEGER NOT NULL UNIQUE REFERENCES "CommissionSlot"("id") ON DELETE RESTRICT,
  "titleSnapshot" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'POINT',
  "state" TEXT NOT NULL DEFAULT 'REQUESTED',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Order_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "Order_currency_check" CHECK ("currency" = 'POINT'),
  CONSTRAINT "Order_state_check" CHECK ("state" IN ('REQUESTED', 'PAID'))
);
CREATE INDEX "Order_buyerId_state_idx" ON "Order"("buyerId", "state");
CREATE INDEX "Order_commissionTypeId_idx" ON "Order"("commissionTypeId");

CREATE TABLE "OrderPayment" (
  "id" SERIAL PRIMARY KEY,
  "orderId" INTEGER NOT NULL REFERENCES "Order"("id") ON DELETE RESTRICT,
  "referenceId" TEXT NOT NULL UNIQUE,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'POINT',
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderPayment_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "OrderPayment_currency_check" CHECK ("currency" = 'POINT'),
  CONSTRAINT "OrderPayment_state_check" CHECK ("state" IN ('PENDING', 'PAID'))
);
CREATE INDEX "OrderPayment_orderId_state_idx" ON "OrderPayment"("orderId", "state");

CREATE TABLE "FinancialTransfer" (
  "id" SERIAL PRIMARY KEY,
  "reservationId" INTEGER NOT NULL UNIQUE REFERENCES "FinancialReservation"("id") ON DELETE RESTRICT,
  "fromAccountId" INTEGER NOT NULL REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT,
  "toAccountId" INTEGER NOT NULL REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialTransfer_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "FinancialTransfer_accounts_check" CHECK ("fromAccountId" <> "toAccountId")
);

CREATE TABLE "FinancialTransferAllocation" (
  "transferId" INTEGER NOT NULL REFERENCES "FinancialTransfer"("id") ON DELETE RESTRICT,
  "lotId" INTEGER NOT NULL REFERENCES "PointLot"("id") ON DELETE RESTRICT,
  "amount" INTEGER NOT NULL,
  PRIMARY KEY ("transferId", "lotId"),
  CONSTRAINT "FinancialTransferAllocation_amount_check" CHECK ("amount" > 0)
);

CREATE TABLE "OrderFinancialLink" (
  "orderPaymentId" INTEGER PRIMARY KEY REFERENCES "OrderPayment"("id") ON DELETE RESTRICT,
  "reservationId" INTEGER NOT NULL UNIQUE REFERENCES "FinancialReservation"("id") ON DELETE RESTRICT
);

CREATE TABLE "Contract" (
  "id" SERIAL PRIMARY KEY,
  "orderId" INTEGER NOT NULL REFERENCES "Order"("id") ON DELETE RESTRICT,
  "buyerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "workerId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "formedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Contract_orderId_key" UNIQUE ("orderId")
);
CREATE INDEX "Contract_buyerId_idx" ON "Contract"("buyerId");
CREATE INDEX "Contract_workerId_idx" ON "Contract"("workerId");

CREATE TABLE "CheckoutCommand" (
  "commandKey" TEXT PRIMARY KEY,
  "payloadHash" TEXT NOT NULL,
  "orderPaymentId" INTEGER NOT NULL REFERENCES "OrderPayment"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A transfer is valid only when it moves the reservation's exact amount from
-- that holder's AVAILABLE account into that reservation's ESCROW account, and
-- every allocation names a lot from the source account. Deferred constraint
-- triggers let the writer insert the transfer before its allocation rows while
-- still making the relationship a commit-time database invariant.
CREATE FUNCTION assert_financial_transfer_conservation(checked_transfer_id INTEGER)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT NOT (
    transfer."amount" = reservation."targetAmount"
    AND source."holderId" = reservation."holderId"
    AND source."purpose" = 'AVAILABLE'
    AND source."currency" = reservation."currency"
    AND destination."reservationId" = reservation."id"
    AND destination."purpose" = 'ESCROW'
    AND destination."currency" = reservation."currency"
    AND COUNT(allocation.*) > 0
    AND COALESCE(SUM(allocation."amount"), 0) = transfer."amount"
    AND BOOL_AND(lot."accountId" = transfer."fromAccountId")
  )
  INTO violates
  FROM "FinancialTransfer" transfer
  JOIN "FinancialReservation" reservation ON reservation."id" = transfer."reservationId"
  JOIN "FinancialAccount" source ON source."id" = transfer."fromAccountId"
  JOIN "FinancialAccount" destination ON destination."id" = transfer."toAccountId"
  LEFT JOIN "FinancialTransferAllocation" allocation ON allocation."transferId" = transfer."id"
  LEFT JOIN "PointLot" lot ON lot."id" = allocation."lotId"
  WHERE transfer."id" = checked_transfer_id
  GROUP BY transfer."id", reservation."id", source."id", destination."id";

  IF violates THEN
    RAISE EXCEPTION 'FinancialTransfer_conservation_check: transfer % violates conservation', checked_transfer_id
      USING ERRCODE = '23514', CONSTRAINT = 'FinancialTransfer_conservation_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_financial_transfer_row()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_financial_transfer_conservation(COALESCE(NEW."id", OLD."id"));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "FinancialTransfer_conservation_check"
AFTER INSERT OR UPDATE ON "FinancialTransfer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_financial_transfer_row();

CREATE FUNCTION assert_point_lot_conservation(checked_lot_id INTEGER)
RETURNS VOID AS $$
DECLARE
  violates BOOLEAN;
BEGIN
  SELECT lot."remainingAmount" + COALESCE(SUM(allocation."amount"), 0) <> lot."originalAmount"
  INTO violates
  FROM "PointLot" lot
  LEFT JOIN "FinancialTransferAllocation" allocation ON allocation."lotId" = lot."id"
  WHERE lot."id" = checked_lot_id
  GROUP BY lot."id";

  IF violates THEN
    RAISE EXCEPTION 'PointLot_conservation_check: lot % remaining value and allocations do not equal its original amount', checked_lot_id
      USING ERRCODE = '23514', CONSTRAINT = 'PointLot_conservation_check';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION check_point_lot_row()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM assert_point_lot_conservation(COALESCE(NEW."id", OLD."id"));
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PointLot_conservation_check"
AFTER UPDATE ON "PointLot"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_point_lot_row();

CREATE FUNCTION check_financial_allocation_row()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM assert_financial_transfer_conservation(OLD."transferId");
    PERFORM assert_point_lot_conservation(OLD."lotId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM assert_financial_transfer_conservation(NEW."transferId");
    PERFORM assert_point_lot_conservation(NEW."lotId");
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialTransferAllocation_conservation_check"
AFTER INSERT OR UPDATE OR DELETE ON "FinancialTransferAllocation"
FOR EACH ROW EXECUTE FUNCTION check_financial_allocation_row();
