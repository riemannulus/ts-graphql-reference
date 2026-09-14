import type { DbClient } from '../../db/db.js';

export async function applyCommissionCheckoutContractFormation(
  db: DbClient,
  formation: { orderId: number; flowId: string; buyerId: number; workerId: number },
) {
  return db.contract.create({ data: formation, select: { id: true } });
}
