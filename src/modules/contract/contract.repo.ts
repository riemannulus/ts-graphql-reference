import type { DbClient, ReadDbClient } from '../../db/db.js';
import { DomainError } from '../../foundation/errors.js';

export class CommissionContractNotFoundError extends DomainError {
  constructor(contractId: number) {
    super(`Commission Contract ${contractId} does not exist`, 'COMMISSION_CONTRACT_NOT_FOUND');
  }
}

export interface CommissionSettlementContract {
  id: number;
  orderId: number;
  flowId: string;
  workerId: number;
}

export async function loadCommissionSettlementContract(
  db: ReadDbClient,
  contractId: number,
): Promise<CommissionSettlementContract> {
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
  return contract;
}

export async function applyCommissionCheckoutContractFormation(
  db: DbClient,
  formation: { orderId: number; flowId: string; buyerId: number; workerId: number },
) {
  return db.contract.create({ data: formation, select: { id: true } });
}
