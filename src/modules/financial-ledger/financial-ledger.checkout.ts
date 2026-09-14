import type { DbClient, ReadDbClient } from '../../db/db.js';
import { planReservation } from './financial-ledger.core.js';
import { applyReservation, findHolderId, loadAvailablePointWorld } from './financial-ledger.repo.js';

export const locateFinancialHolder = (
  db: ReadDbClient,
  binding: { namespace: 'user'; key: string },
) => findHolderId(db, binding);

export async function reserveFundsForCheckout(
  db: DbClient,
  request: {
    referenceId: string;
    bindingNamespace: string;
    bindingKey: string;
    holderId: number;
    purpose: 'COMMISSION_PAYMENT';
    currency: 'POINT';
    amount: number;
  },
) {
  const world = await loadAvailablePointWorld(db, request.holderId);
  const allocations = planReservation(world.lots, request.amount);
  const reservation = await applyReservation(db, request, world.accountId, allocations);
  return { reservationId: reservation.id, ...request };
}
