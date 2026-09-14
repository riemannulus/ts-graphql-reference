import type { DbClient } from '../../db/db.js';

export async function applyContractFormation(
  db: DbClient,
  formation: { orderId: number; buyerId: number; workerId: number },
) {
  return db.contract.create({ data: formation, select: { id: true } });
}
