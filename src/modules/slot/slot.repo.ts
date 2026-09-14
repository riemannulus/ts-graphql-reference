import type { DbClient, ReadDbClient } from '../../db/db.js';
import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';

export class CommissionSlotNotFoundError extends DomainError {
  constructor(id: number) {
    super(`Commission slot ${id} does not exist`, 'COMMISSION_SLOT_NOT_FOUND');
  }
}

export async function loadCommissionCheckoutSlot(db: ReadDbClient, id: number) {
  const row = await db.commissionSlot.findUnique({
    where: { id },
    select: { id: true, workerId: true, state: true },
  });
  if (!row) throw new CommissionSlotNotFoundError(id);
  return { slotId: row.id, workerId: row.workerId, state: row.state };
}

export async function applyCommissionCheckoutSlotOccupation(
  db: DbClient,
  input: { slotId: number; workerId: number },
): Promise<void> {
  const result = await db.commissionSlot.updateMany({
    where: { id: input.slotId, workerId: input.workerId, state: 'AVAILABLE' },
    data: { state: 'OCCUPIED' },
  });
  if (result.count !== 1) throw new ConcurrentUpdateError(`CommissionSlot ${input.slotId}`);
}
