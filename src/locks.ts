/**
 * Advisory-lock key registry and global ordering — the PURE key policy of the
 * concurrency ladder (see CONVENTIONS "Concurrency: the ladder"). No imports, no
 * I/O: this module only says what is lockable and in what order, and is
 * lint-enforced free of transactions and framework deps. The raw acquisition SQL
 * lives in `uow.ts` (beside its `SET TRANSACTION`); a service reaches locks only
 * through `uow.serialized` / `uow.trySerialized`.
 *
 * Advisory locks are the top rung: reach for them only when an invariant spans
 * rows in a way a single guarded write or a REPEATABLE READ snapshot cannot
 * express, and remember that a lock only serializes writers that take the SAME
 * key. Prefer the lower rungs.
 *
 * A key is a `(namespace, id)` pair for the two-int form
 * `pg_advisory_xact_lock(classid int, objid int)`, so `pg_locks` shows exactly
 * which entity is locked. `classid` is the namespace's ordinal; `objid` is the
 * entity id. Reference ids are `Int` (int4) and used directly; a system with
 * string / UUID ids would hash them to an int4 here — that constructor is the
 * only thing that would change.
 */

// Declaration order == acquisition order ACROSS namespaces. Append new
// namespaces at the END; never reorder — one global order over all keys is what
// makes multi-key acquisition deadlock-free (see `orderLocks`).
const LOCK_NAMESPACES = ['pointBalance'] as const;
export type LockNamespace = (typeof LOCK_NAMESPACES)[number];

const NAMESPACE_ORDINAL = Object.fromEntries(
  LOCK_NAMESPACES.map((name, index) => [name, index + 1]),
) as Record<LockNamespace, number>;

export interface LockKey {
  /** `classid` — the namespace ordinal (stable, from declaration order). */
  readonly ns: number;
  /** `objid` — the entity id (must fit int4). */
  readonly obj: number;
  /** Human-readable `namespace:id`, for errors and debugging. */
  readonly label: string;
}

function makeKey(namespace: LockNamespace, id: number): LockKey {
  return { ns: NAMESPACE_ORDINAL[namespace], obj: id, label: `${namespace}:${id}` };
}

/**
 * The ONLY way to construct a lock key: one constructor per lockable entity.
 * Add a constructor (and, if it is new, its namespace above) when a new entity
 * needs serializing.
 */
export const lockKey = {
  /** Serializes all point movement for one user (balance + charge ledger). */
  pointBalance: (userId: number): LockKey => makeKey('pointBalance', userId),
};

/**
 * Global acquisition order: sort by `(namespace, id)` and drop duplicates.
 * PURE. Every caller that acquires a set of keys does so in this same order, so
 * two transactions locking an overlapping set can never form a wait-for cycle
 * (no deadlock). Deduplication makes locking the same key twice — e.g. a
 * self-transfer — a single lock.
 */
export function orderLocks(keys: readonly LockKey[]): LockKey[] {
  const seen = new Set<string>();
  const unique: LockKey[] = [];
  for (const key of keys) {
    const id = `${key.ns}:${key.obj}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(key);
  }
  return unique.toSorted((a, b) => a.ns - b.ns || a.obj - b.obj);
}
