-- CreateEnum
CREATE TYPE "TransactionFlowKind" AS ENUM ('COMMISSION');

-- CreateEnum
CREATE TYPE "FinancialCommandKind" AS ENUM ('PAY', 'EXTRA_PAY', 'SETTLE', 'REFUND', 'CANCEL');

-- DropForeignKey
ALTER TABLE "CheckoutCommand" DROP CONSTRAINT "CheckoutCommand_orderPaymentId_fkey";

-- DropForeignKey
ALTER TABLE "Contract" DROP CONSTRAINT "Contract_orderId_fkey";

-- DropForeignKey
ALTER TABLE "FinancialTransfer" DROP CONSTRAINT "FinancialTransfer_reservationId_fkey";

-- DropForeignKey
ALTER TABLE "OrderFinancialLink" DROP CONSTRAINT "OrderFinancialLink_orderPaymentId_fkey";

-- DropForeignKey
ALTER TABLE "OrderFinancialLink" DROP CONSTRAINT "OrderFinancialLink_reservationId_fkey";

-- DropForeignKey
ALTER TABLE "OrderPayment" DROP CONSTRAINT "OrderPayment_orderId_fkey";

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "flowId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "FinancialReservation" ADD COLUMN     "flowId" UUID NOT NULL,
ALTER COLUMN "referenceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "FinancialTransfer" ADD COLUMN     "actionId" UUID NOT NULL,
ADD COLUMN     "flowId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "flowId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "OrderFinancialLink" ADD COLUMN     "flowId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "OrderPayment" ADD COLUMN     "flowId" UUID NOT NULL,
ALTER COLUMN "referenceId" DROP NOT NULL;

-- DropTable
DROP TABLE "CheckoutCommand";

-- CreateTable
CREATE TABLE "TransactionFlow" (
    "id" UUID NOT NULL,
    "kind" "TransactionFlowKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowCommandPolicy" (
    "flowId" UUID NOT NULL,
    "commandKind" "FinancialCommandKind" NOT NULL,

    CONSTRAINT "FlowCommandPolicy_pkey" PRIMARY KEY ("flowId","commandKind")
);

-- CreateTable
CREATE TABLE "FinancialCommandRun" (
    "id" UUID NOT NULL,
    "flowId" UUID NOT NULL,
    "flowKind" "TransactionFlowKind" NOT NULL,
    "kind" "FinancialCommandKind" NOT NULL,
    "principalId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "subjectNamespace" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "resultOperationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialCommandRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialOperation" (
    "id" UUID NOT NULL,
    "flowId" UUID NOT NULL,
    "kind" "FinancialCommandKind" NOT NULL,
    "originatingCommandId" UUID NOT NULL,
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialTransferAction" (
    "id" UUID NOT NULL,
    "flowId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialTransferAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionFlow_id_kind_key" ON "TransactionFlow"("id", "kind");

-- CreateIndex
CREATE INDEX "FinancialCommandRun_subjectNamespace_subjectKey_kind_create_idx" ON "FinancialCommandRun"("subjectNamespace", "subjectKey", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialCommandRun_principalId_kind_idempotencyKey_key" ON "FinancialCommandRun"("principalId", "kind", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialCommandRun_id_flowId_kind_key" ON "FinancialCommandRun"("id", "flowId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_originatingCommandId_key" ON "FinancialOperation"("originatingCommandId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_id_flowId_kind_key" ON "FinancialOperation"("id", "flowId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_id_flowId_key" ON "FinancialOperation"("id", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialOperation_originatingCommandId_flowId_kind_key" ON "FinancialOperation"("originatingCommandId", "flowId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransferAction_id_flowId_key" ON "FinancialTransferAction"("id", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_orderId_flowId_key" ON "Contract"("orderId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialReservation_id_flowId_key" ON "FinancialReservation"("id", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransfer_actionId_key" ON "FinancialTransfer"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransfer_reservationId_flowId_key" ON "FinancialTransfer"("reservationId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransfer_actionId_flowId_key" ON "FinancialTransfer"("actionId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_flowId_key" ON "Order"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_flowId_key" ON "Order"("id", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFinancialLink_orderPaymentId_flowId_key" ON "OrderFinancialLink"("orderPaymentId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFinancialLink_reservationId_flowId_key" ON "OrderFinancialLink"("reservationId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPayment_id_flowId_key" ON "OrderPayment"("id", "flowId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "TransactionFlow"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrderPayment" ADD CONSTRAINT "OrderPayment_orderId_flowId_fkey" FOREIGN KEY ("orderId", "flowId") REFERENCES "Order"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialReservation" ADD CONSTRAINT "FinancialReservation_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "TransactionFlow"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialTransfer" ADD CONSTRAINT "FinancialTransfer_reservationId_flowId_fkey" FOREIGN KEY ("reservationId", "flowId") REFERENCES "FinancialReservation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialTransfer" ADD CONSTRAINT "FinancialTransfer_actionId_flowId_fkey" FOREIGN KEY ("actionId", "flowId") REFERENCES "FinancialTransferAction"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrderFinancialLink" ADD CONSTRAINT "OrderFinancialLink_orderPaymentId_flowId_fkey" FOREIGN KEY ("orderPaymentId", "flowId") REFERENCES "OrderPayment"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OrderFinancialLink" ADD CONSTRAINT "OrderFinancialLink_reservationId_flowId_fkey" FOREIGN KEY ("reservationId", "flowId") REFERENCES "FinancialReservation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_orderId_flowId_fkey" FOREIGN KEY ("orderId", "flowId") REFERENCES "Order"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FlowCommandPolicy" ADD CONSTRAINT "FlowCommandPolicy_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "TransactionFlow"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialCommandRun" ADD CONSTRAINT "FinancialCommandRun_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialCommandRun" ADD CONSTRAINT "FinancialCommandRun_flowId_flowKind_fkey" FOREIGN KEY ("flowId", "flowKind") REFERENCES "TransactionFlow"("id", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialCommandRun" ADD CONSTRAINT "FinancialCommandRun_flowId_kind_fkey" FOREIGN KEY ("flowId", "kind") REFERENCES "FlowCommandPolicy"("flowId", "commandKind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialCommandRun" ADD CONSTRAINT "FinancialCommandRun_resultOperationId_flowId_kind_fkey" FOREIGN KEY ("resultOperationId", "flowId", "kind") REFERENCES "FinancialOperation"("id", "flowId", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialOperation" ADD CONSTRAINT "FinancialOperation_originatingCommandId_flowId_kind_fkey" FOREIGN KEY ("originatingCommandId", "flowId", "kind") REFERENCES "FinancialCommandRun"("id", "flowId", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialTransferAction" ADD CONSTRAINT "FinancialTransferAction_operationId_flowId_fkey" FOREIGN KEY ("operationId", "flowId") REFERENCES "FinancialOperation"("id", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;
