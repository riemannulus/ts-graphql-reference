import { fc, test } from '@fast-check/vitest';
import { expect } from 'vitest';
import { type LockKey, lockKey, orderLocks } from '../../locks.js';

// The laws of the global lock order. orderLocks is pure, so its deadlock-freedom
// guarantee — every caller acquires an overlapping key set in the SAME order —
// is a property, provable with no database. Keys are fabricated across several
// namespaces (the sort is total over LockKey, independent of the registry).

const arbLockKey: fc.Arbitrary<LockKey> = fc
  .record({ ns: fc.integer({ min: 1, max: 4 }), obj: fc.integer({ min: -1_000, max: 1_000 }) })
  .map(({ ns, obj }) => ({ ns, obj, label: `${ns}:${obj}` }));

const keyId = (k: LockKey) => `${k.ns}:${k.obj}`;

test.prop([fc.array(arbLockKey, { maxLength: 12 })])(
  'output is strictly increasing by (namespace, id)',
  (keys) => {
    const ordered = orderLocks(keys);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const cur = ordered[i]!;
      expect(prev.ns < cur.ns || (prev.ns === cur.ns && prev.obj < cur.obj)).toBe(true);
    }
  },
);

test.prop([fc.array(arbLockKey, { maxLength: 12 })])(
  'output is the deduplicated set of the input keys — nothing added, nothing lost',
  (keys) => {
    const ordered = orderLocks(keys);
    expect(new Set(ordered.map(keyId))).toEqual(new Set(keys.map(keyId)));
    expect(ordered.length).toBe(new Set(keys.map(keyId)).size);
  },
);

test.prop([fc.array(arbLockKey, { maxLength: 12 })])(
  'the acquisition order is independent of the input order (this is what avoids deadlock)',
  (keys) => {
    expect(orderLocks(keys)).toEqual(orderLocks(keys.toReversed()));
  },
);

test.prop([fc.array(arbLockKey, { maxLength: 12 })])('is idempotent', (keys) => {
  const once = orderLocks(keys);
  expect(orderLocks(once)).toEqual(once);
});

test.prop([fc.integer({ min: 1, max: 100_000 })])(
  'lockKey.pointBalance maps a user id into the pointBalance namespace unchanged',
  (userId) => {
    const key = lockKey.pointBalance(userId);
    expect(key.obj).toBe(userId);
    expect(key.label).toBe(`pointBalance:${userId}`);
  },
);
