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
 * string / UUID ids would hash them to an int4 in that entity's mapper — the
 * mapper is the only thing that would change.
 */

export interface LockKey {
  /** `classid` — the namespace ordinal (stable, from declaration order). */
  readonly ns: number;
  /** `objid` — the entity id (must fit int4). */
  readonly obj: number;
  /** Human-readable `namespace:id`, for errors and debugging. */
  readonly label: string;
}

/**
 * Builds the lock-key registry from ONE declaration — the single place to touch
 * when a new entity needs serializing. Each entry is a lockable entity: its key
 * is the namespace, its value maps the entity's identifier(s) to an int4
 * `objid`. The namespace ordinal (`classid`) is the entry's position, so
 * DECLARATION ORDER == acquisition order ACROSS namespaces: append new entries
 * at the END, never reorder — one global order over all keys is what makes
 * multi-key acquisition deadlock-free (see `orderLocks`). Insertion order is
 * preserved because every namespace is a non-numeric string key.
 */
function defineLocks<T extends Record<string, (...args: never[]) => number>>(
  entities: T,
): { readonly [K in keyof T]: (...args: Parameters<T[K]>) => LockKey } {
  const registry: Record<string, (...args: never[]) => LockKey> = {};
  Object.entries(entities).forEach(([namespace, toObjId], index) => {
    const ns = index + 1;
    registry[namespace] = (...args: never[]) => {
      const obj = toObjId(...args);
      return { ns, obj, label: `${namespace}:${obj}` };
    };
  });
  return registry as unknown as { readonly [K in keyof T]: (...args: Parameters<T[K]>) => LockKey };
}

/**
 * The ONLY way to construct a lock key, and the ONE place to register a lockable
 * entity: add an entry (namespace → id-to-`objid` mapper) here — nothing else in
 * this module changes. See `defineLocks` for the ordering rule.
 */
export const lockKey = defineLocks({
  /** Serializes all point movement for one user (balance + charge ledger). */
  pointBalance: (userId: number) => userId,
});

/** The registered lock namespaces, derived from the registry. */
export type LockNamespace = keyof typeof lockKey;

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
