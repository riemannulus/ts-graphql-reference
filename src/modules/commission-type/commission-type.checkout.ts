import type { ReadDbClient } from '../../db/db.js';
import { findCommissionTypeForCheckout } from './commission-type.repo.js';

export const loadCommissionTypeForCheckout = (db: ReadDbClient, id: number) =>
  findCommissionTypeForCheckout(db, id);
