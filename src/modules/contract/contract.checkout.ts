import type { DbClient } from '../../db/db.js';
import { insertContract } from './contract.repo.js';

export async function createContractFromPaidOrder(
  db: DbClient,
  formation: { orderId: number; buyerId: number; workerId: number },
) {
  const contract = await insertContract(db, formation);
  return { contractId: contract.id };
}
