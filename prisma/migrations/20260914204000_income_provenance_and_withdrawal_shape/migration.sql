-- DropForeignKey
ALTER TABLE "FinancialSwapAction" DROP CONSTRAINT "FinancialSwapAction_operationId_flowId_fkey";

-- DropForeignKey
ALTER TABLE "FinancialTransferAction" DROP CONSTRAINT "FinancialTransferAction_operationId_flowId_fkey";

-- DropForeignKey
ALTER TABLE "FinancialWithdrawal" DROP CONSTRAINT "FinancialWithdrawal_holderId_fkey";

-- DropIndex
DROP INDEX "FinancialWithdrawal_holderId_state_idx";

-- AlterTable
ALTER TABLE "FinancialLot" ADD COLUMN     "sourceFlowKind" "TransactionFlowKind",
ADD COLUMN     "sourceSwapActionId" UUID;

-- AlterTable
ALTER TABLE "FinancialSwapAction" ADD COLUMN     "beneficiaryHolderId" INTEGER NOT NULL,
ADD COLUMN     "operationKind" "FinancialCommandKind" NOT NULL DEFAULT 'SETTLE';

-- AlterTable
ALTER TABLE "FinancialTransferAction" ADD COLUMN     "operationKind" "FinancialCommandKind" NOT NULL DEFAULT 'PAY';

-- AlterTable
ALTER TABLE "FinancialWithdrawal" DROP COLUMN "amount",
DROP COLUMN "currency",
DROP COLUMN "holderId",
DROP COLUMN "state",
ADD COLUMN     "operationId" UUID NOT NULL,
ADD COLUMN     "operationKind" "FinancialCommandKind" NOT NULL DEFAULT 'WITHDRAW',
ADD COLUMN     "transferActionId" UUID NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "FinancialLot_sourceSwapActionId_key" ON "FinancialLot"("sourceSwapActionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialLot_sourceSwapActionId_sourceOperationId_sourceFlo_key" ON "FinancialLot"("sourceSwapActionId", "sourceOperationId", "sourceFlowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialSwapAction_operationId_flowId_operationKind_key" ON "FinancialSwapAction"("operationId", "flowId", "operationKind");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialSwapAction_id_operationId_flowId_key" ON "FinancialSwapAction"("id", "operationId", "flowId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransferAction_operationId_key" ON "FinancialTransferAction"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransferAction_id_operationId_flowId_operationKind_key" ON "FinancialTransferAction"("id", "operationId", "flowId", "operationKind");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialWithdrawal_operationId_key" ON "FinancialWithdrawal"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialWithdrawal_transferActionId_key" ON "FinancialWithdrawal"("transferActionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialWithdrawal_transferActionId_operationId_flowId_ope_key" ON "FinancialWithdrawal"("transferActionId", "operationId", "flowId", "operationKind");

-- AddForeignKey
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_sourceFlowId_sourceFlowKind_fkey" FOREIGN KEY ("sourceFlowId", "sourceFlowKind") REFERENCES "TransactionFlow"("id", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialLot" ADD CONSTRAINT "FinancialLot_sourceSwapActionId_sourceOperationId_sourceFl_fkey" FOREIGN KEY ("sourceSwapActionId", "sourceOperationId", "sourceFlowId") REFERENCES "FinancialSwapAction"("id", "operationId", "flowId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialTransferAction" ADD CONSTRAINT "FinancialTransferAction_operationId_flowId_operationKind_fkey" FOREIGN KEY ("operationId", "flowId", "operationKind") REFERENCES "FinancialOperation"("id", "flowId", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialSwapAction" ADD CONSTRAINT "FinancialSwapAction_operationId_flowId_operationKind_fkey" FOREIGN KEY ("operationId", "flowId", "operationKind") REFERENCES "FinancialOperation"("id", "flowId", "kind") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialSwapAction" ADD CONSTRAINT "FinancialSwapAction_beneficiaryHolderId_fkey" FOREIGN KEY ("beneficiaryHolderId") REFERENCES "FinancialHolder"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FinancialWithdrawal" ADD CONSTRAINT "FinancialWithdrawal_transferActionId_operationId_flowId_op_fkey" FOREIGN KEY ("transferActionId", "operationId", "flowId", "operationKind") REFERENCES "FinancialTransferAction"("id", "operationId", "flowId", "operationKind") ON DELETE RESTRICT ON UPDATE NO ACTION;
