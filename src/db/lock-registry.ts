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

/**
 * The ONLY way to construct a lock key. Add an entry (namespace → id-to-`objid`
 * mapper) to register a new lockable entity; see the ordering rule above.
 */
export const lockKey = defineLocks({
  /** Serializes all point movement for one user (balance + charge ledger). */
  pointBalance: (userId: number) => userId,
});

/** The registered lock namespaces, derived from the registry. */
export type LockNamespace = keyof typeof lockKey;
