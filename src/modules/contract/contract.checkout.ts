import type { DbClient } from '../../db/db.js';

export async function createContractFromPaidOrder(
  db: DbClient,
  formation: { orderId: number; buyerId: number; workerId: number; reservationId: number },
) {
  const contract = await db.contract.create({
    data: { orderId: formation.orderId, buyerId: formation.buyerId, workerId: formation.workerId },
  });
  return { contractId: contract.id };
}
