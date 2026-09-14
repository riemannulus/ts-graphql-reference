/**
 * The lock registry — the ONE place that says WHAT is lockable, kept apart from
 * the machinery in `locks.ts` so this is the only file that grows. Each entry is
 * a lockable entity: its key is the namespace, its value maps the entity's
 * identifier(s) to an int4 `objid`. Serializing a new entity is a one-line
 * change here; `locks.ts` (the key type, the builder, the ordering law) does not
 * change.
 *
 * DECLARATION ORDER == acquisition order ACROSS namespaces — an entry's position
 * is its namespace ordinal (`classid`). Append new entries at the END, never
 * reorder: one global order over all keys is what makes multi-key acquisition
 * deadlock-free (see `orderLocks`). Like `locks.ts`, this module stays pure —
 * no I/O, no transactions, no framework deps (lint-enforced).
 */
import { defineLocks } from './locks.js';

/** Stable FNV-1a mapping for string identifiers; collisions only add contention. */
function stringLockId(value: string): number {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * The ONLY way to construct a lock key. Add an entry (namespace → id-to-`objid`
 * mapper) to register a new lockable entity; see the ordering rule above.
 */
export const lockKey = defineLocks({
  /** Serializes all point movement for one user (balance + charge ledger). */
  pointBalance: (userId: number) => userId,
  /** PROTOTYPE: serializes one initial payment and its replay result. */
  orderPayment: (orderPaymentId: number) => orderPaymentId,
  /** PROTOTYPE: serializes all generic financial movement for one holder. */
  financialHolder: (holderId: number) => holderId,
  /** PROTOTYPE: serializes commission checkout against occupation of one commission slot. */
  commissionSlot: (slotId: number) => slotId,
  /** PROTOTYPE: claims one commission-checkout command key before any economic write. */
  commissionCheckoutCommand: (commandKey: string) => stringLockId(commandKey),
});

/** The registered lock namespaces, derived from the registry. */
export type LockNamespace = keyof typeof lockKey;
