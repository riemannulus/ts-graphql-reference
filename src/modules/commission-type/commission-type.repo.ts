import type { ReadDbClient } from '../../db/db.js';
import { DomainError } from '../../foundation/errors.js';

export class CommissionTypeNotFoundError extends DomainError {
  constructor(id: number) {
    super(`Commission type ${id} does not exist`, 'COMMISSION_TYPE_NOT_FOUND');
  }
}

export async function findCommissionTypeForCheckout(db: ReadDbClient, id: number) {
  const row = await db.commissionType.findUnique({
    where: { id },
    select: { workerId: true, price: true },
  });
  if (!row) throw new CommissionTypeNotFoundError(id);
  return row;
}
