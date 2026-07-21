/**
 * Advisory-lock MACHINERY — the pure key type, the registry builder, and the
 * global acquisition order (see CONVENTIONS "Concurrency: the ladder"). No
 * imports, no I/O: this module is lint-enforced free of transactions and
 * framework deps. WHAT is lockable lives in `lock-registry.ts` (the one place
 * that grows); this is the stable machinery behind it. The raw acquisition SQL
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
 * Builds a lock-key registry from one declaration — see `lock-registry.ts` for
 * the sole call and the append-only ordering rule. Each entry's KEY is a
 * namespace and its VALUE maps the entity's identifier(s) to an int4 `objid`;
 * the namespace ordinal (`classid`) is the entry's position, so declaration
 * order becomes the global acquisition order. Insertion order is preserved
 * because every namespace is a non-numeric string key.
 */
export function defineLocks<T extends Record<string, (...args: never[]) => number>>(
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
