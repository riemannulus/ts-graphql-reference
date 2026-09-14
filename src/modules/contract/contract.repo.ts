import type { DbClient, ReadDbClient } from '../../db/db.js';
import { DomainError } from '../../foundation/errors.js';

export class CommissionContractNotFoundError extends DomainError {
  constructor(contractId: number) {
    super(`Commission Contract ${contractId} does not exist`, 'COMMISSION_CONTRACT_NOT_FOUND');
  }
}

export async function loadCommissionSettlementContractFacts(db: ReadDbClient, contractId: number) {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: {
      id: true,
      flowId: true,
      workerId: true,
      orderId: true,
    },
  });
  if (!contract) throw new CommissionContractNotFoundError(contractId);
  return {
    contractId: contract.id,
    contractOrderId: contract.orderId,
    flowId: contract.flowId,
    workerId: contract.workerId,
  };
}

export async function applyCommissionCheckoutContractFormation(
  db: DbClient,
  formation: { orderId: number; flowId: string; buyerId: number; workerId: number },
) {
  return db.contract.create({ data: formation, select: { id: true } });
}
