import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../db/prisma.js';
import { PointChargeStateError } from '../../modules/point-charge/point-charge.core.js';
import { createPointChargeService } from '../../modules/point-charge/point-charge.service.js';
import { resetDb } from '../support/helpers.js';

const databaseUrl =
  process.env.POINT_CHARGE_RACE_DATABASE_URL ??
  process.env.COMMISSION_CHECKOUT_RACE_DATABASE_URL;
const BARRIER_CLASS_ID = 1_900_000_001;
const BARRIER_OBJECT_ID = 1_900_000_001;

function connectionUrl(applicationName: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

const first = databaseUrl ? createPrismaClient(connectionUrl('point-charge-race-first')) : null;
const second = databaseUrl ? createPrismaClient(connectionUrl('point-charge-race-second')) : null;
const monitor = databaseUrl ? createPrismaClient(connectionUrl('point-charge-race-monitor')) : null;

beforeAll(async () => {
  if (!first) return;
  await first.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS point_charge_test_lot_barrier ON "FinancialLot"',
  );
  await first.$executeRawUnsafe('DROP FUNCTION IF EXISTS point_charge_test_lot_barrier()');
  await first.$executeRawUnsafe(`
    CREATE FUNCTION point_charge_test_lot_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."sourceOperationKind" = 'CHARGE'
        AND current_setting('application_name') = 'point-charge-race-first'
      THEN
        PERFORM pg_advisory_xact_lock(${BARRIER_CLASS_ID}, ${BARRIER_OBJECT_ID});
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await first.$executeRawUnsafe(`
    CREATE TRIGGER point_charge_test_lot_barrier
    BEFORE INSERT ON "FinancialLot"
    FOR EACH ROW EXECUTE FUNCTION point_charge_test_lot_barrier()
  `);
});

beforeEach(async () => {
  if (first) await resetDb(first);
});

afterAll(async () => {
  if (first) {
    await first.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS point_charge_test_lot_barrier ON "FinancialLot"',
    );
    await first.$executeRawUnsafe('DROP FUNCTION IF EXISTS point_charge_test_lot_barrier()');
  }
  await Promise.all([first?.$disconnect(), second?.$disconnect(), monitor?.$disconnect()]);
});

function requireClients() {
  if (!first || !second || !monitor) {
    throw new Error('POINT_CHARGE_RACE_DATABASE_URL is required');
  }
  return { first, second, monitor };
}

async function waitForLock(input: {
  applicationName: string;
  classId?: number;
  objectId?: number;
}) {
  const clients = requireClients();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the lock-wait path
    const [state] = await clients.monitor.$queryRawUnsafe<Array<{ waiting: boolean }>>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_locks lock
        JOIN pg_stat_activity activity ON activity.pid = lock.pid
        WHERE lock.locktype = 'advisory'
          AND NOT lock.granted
          AND activity.application_name = $1
          AND ($2::INTEGER IS NULL OR lock.classid = $2)
          AND ($3::INTEGER IS NULL OR lock.objid = $3)
      ) AS waiting`,
      input.applicationName,
      input.classId ?? null,
      input.objectId ?? null,
    );
    if (state?.waiting) return;
    // eslint-disable-next-line no-await-in-loop -- bounded polling proves the lock-wait path
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${input.applicationName} never waited on the expected advisory lock`);
}

async function lotBarrier() {
  const blocker = new Client({ connectionString: connectionUrl('point-charge-race-barrier') });
  await blocker.connect();
  await blocker.query('SELECT pg_advisory_lock($1, $2)', [BARRIER_CLASS_ID, BARRIER_OBJECT_ID]);
  let released = false;
  return {
    waitUntilReached: () =>
      waitForLock({
        applicationName: 'point-charge-race-first',
        classId: BARRIER_CLASS_ID,
        objectId: BARRIER_OBJECT_ID,
      }),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await blocker.query('SELECT pg_advisory_unlock($1, $2)', [
          BARRIER_CLASS_ID,
          BARRIER_OBJECT_ID,
        ]);
      } finally {
        await blocker.end();
      }
    },
  };
}

async function seedPointAccount() {
  const clients = requireClients();
  const user = await clients.first.user.create({
    data: { email: 'point-charge-race@example.com' },
  });
  const holder = await clients.first.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(user.id) },
  });
  await clients.first.financialAccount.create({
    data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  return user;
}

describe.skipIf(!databaseUrl)('point charge concurrency on PostgreSQL', () => {
  it('waits and replays a concurrent retry for the same external payment', async () => {
    const clients = requireClients();
    const user = await seedPointAccount();
    const barrier = await lotBarrier();
    try {
      const firstRequest = createPointChargeService({ rw: clients.first, ro: clients.first }).charge({
        actorId: user.id,
        amount: 500,
        externalPaymentId: 'pg-race-same-payment',
        commandKey: 'race-first-key',
      });
      await barrier.waitUntilReached();
      const secondRequest = createPointChargeService({ rw: clients.second, ro: clients.second }).charge({
        actorId: user.id,
        amount: 500,
        externalPaymentId: 'pg-race-same-payment',
        commandKey: 'race-second-key',
      });
      const wait = waitForLock({ applicationName: 'point-charge-race-second' });
      await wait;
      await barrier.release();
      const results = await Promise.all([firstRequest, secondRequest]);

      expect(
        results.map((result) => result.replayed).toSorted((left, right) => Number(left) - Number(right)),
      ).toEqual([false, true]);
      expect(results[0].lotId).toBe(results[1].lotId);
      expect(await clients.first.financialLot.count()).toBe(1);
      expect(await clients.first.financialCommandRun.count()).toBe(1);
    } finally {
      await barrier.release();
    }
  });

  it('rejects a concurrent command-key reuse for a different payment', async () => {
    const clients = requireClients();
    const user = await seedPointAccount();
    const barrier = await lotBarrier();
    try {
      const firstRequest = createPointChargeService({ rw: clients.first, ro: clients.first }).charge({
        actorId: user.id,
        amount: 500,
        externalPaymentId: 'pg-race-left',
        commandKey: 'race-shared-key',
      });
      await barrier.waitUntilReached();
      const secondRequest = createPointChargeService({ rw: clients.second, ro: clients.second }).charge({
        actorId: user.id,
        amount: 500,
        externalPaymentId: 'pg-race-right',
        commandKey: 'race-shared-key',
      });
      await waitForLock({ applicationName: 'point-charge-race-second' });
      await barrier.release();
      const outcomes = await Promise.allSettled([firstRequest, secondRequest]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(PointChargeStateError);
      expect(await clients.first.financialLot.count()).toBe(1);
      expect(await clients.first.financialCommandRun.count()).toBe(1);
    } finally {
      await barrier.release();
    }
  });
});
