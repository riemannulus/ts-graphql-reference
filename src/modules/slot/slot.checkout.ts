import type { DbClient, ReadDbClient } from '../../db/db.js';
import { findSlotForCheckout, occupySlot } from './slot.repo.js';

export const loadSlotForCheckout = (db: ReadDbClient, id: number) => findSlotForCheckout(db, id);

export async function confirmSlotForCheckout(
  db: DbClient,
  input: { slotId: number; workerId: number },
): Promise<void> {
  await occupySlot(db, input);
}
