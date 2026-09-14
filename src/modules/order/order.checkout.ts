import type { DbClient, ReadDbClient } from '../../db/db.js';
import { findLockTargets, loadPaymentFacts, markOrderPaid } from './order.repo.js';

export const locateOrderCheckoutLocks = (db: ReadDbClient, orderPaymentId: number) =>
  findLockTargets(db, orderPaymentId);

export const loadOrderPaymentForCheckout = (db: ReadDbClient, orderPaymentId: number) =>
  loadPaymentFacts(db, orderPaymentId);

export const attachReservationAndMarkOrderPaid = (
  db: DbClient,
  input: { orderId: number; orderPaymentId: number; reservationId: number },
) => markOrderPaid(db, input);
