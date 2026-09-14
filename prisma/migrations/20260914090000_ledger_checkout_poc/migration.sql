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
  "currency" TEXT NOT NULL,
  "targetAmount" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'HELD',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialReservation_referenceId_key" UNIQUE ("referenceId"),
  CONSTRAINT "FinancialReservation_bindingNamespace_bindingKey_key" UNIQUE ("bindingNamespace", "bindingKey"),
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
  "reservationId" INTEGER NOT NULL REFERENCES "FinancialReservation"("id") ON DELETE RESTRICT,
  "contractId" INTEGER NOT NULL REFERENCES "Contract"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
