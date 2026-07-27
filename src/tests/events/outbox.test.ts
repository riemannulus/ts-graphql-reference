import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uow } from '../../db/uow.js';
import type { AppEventPublisher } from '../../events/event-registry.js';
import { createOutbox, type Outbox } from '../../events/outbox.js';
import * as outboxRepo from '../../events/outbox.repo.js';
import type { Clock } from '../../foundation/clock.js';
import type { Logger } from '../../foundation/logger.js';
import { addDays } from '../../foundation/time.js';
import { fixedClock } from '../support/clock.js';
import { recordingPublisher } from '../support/event-bus-fake.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

/**
 * The transactional outbox — delivery ladder rung 1 — against the REAL (PGlite)
 * database, because the property it exists for is a property of a transaction
 * and nothing weaker can show it. `fakeOutbox` in `event-bus-fake.ts` proves a
 * service enqueued the right event; only this file proves that a rolled-back
 * write leaves no event behind.
 *
 * PGlite is SINGLE-CONNECTION. A query issued on `prisma` while a `uow`
 * transaction is still open on the same client deadlocks that one connection, so
 * every test here is a strictly sequential chain of awaits: no `Promise.all`, and
 * no assertion inside a `uow.run` body — the body enqueues (or throws) and the
 * assertions happen after it has settled. Genuine multi-drainer contention
 * (`FOR UPDATE SKIP LOCKED` handing two workers disjoint batches) therefore
 * cannot be exercised here at all; what IS pinned is that a single drainer
 * claims, counts, publishes, and marks in the order the design requires.
 */

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

/** Every instant the outbox stamps comes from here, so assertions are equalities. */
const AT = new Date('2026-03-01T12:00:00.000Z');
/**
 * Retention is 7 days — `RETENTION_DAYS` in outbox.ts, restated because it is not
 * exported. That duplication is deliberate: shortening the window silently is
 * exactly the change this file should fail on.
 */
const RETENTION_DAYS = 7;
const CUTOFF = addDays(AT, -RETENTION_DAYS);

beforeEach(() => resetDb(prisma));
afterAll(async () => {
  await prisma.$disconnect();
});

/** One `logger.error` line — the drainer's only channel for "I gave up on this row". */
interface LoggedError {
  readonly fields: object;
  readonly msg: string | undefined;
}

interface RecordingLogger extends Logger {
  readonly errors: LoggedError[];
}

const noop = (): void => undefined;

/**
 * The `Logger` port as a recording fake. Only `error` is kept: it is the one
 * level the outbox uses to report a row it could not deliver, and a drain that
 * silently swallowed a poison row would be indistinguishable from a healthy one.
 * `child()` returns the SAME recorder, since a logger derived mid-drain must
 * still be a logger and its lines must still be findable.
 */
function recordingLogger(): RecordingLogger {
  const errors: LoggedError[] = [];
  const logger: RecordingLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error(first: object | string, msg?: string) {
      errors.push(typeof first === 'string' ? { fields: {}, msg: first } : { fields: first, msg });
    },
    child: () => logger,
    errors,
  };
  return logger;
}

interface FailingPublisher extends AppEventPublisher {
  /** How many times the bus was ASKED to publish, successful or not. */
  readonly calls: () => number;
}

/** A bus that is down. Stands in for Redis being unreachable mid-drain. */
function failingPublisher(): FailingPublisher {
  let calls = 0;
  return {
    publish(): never {
      calls += 1;
      throw new Error('bus is down');
    },
    calls: () => calls,
  };
}

function makeOutbox(deps: {
  bus: AppEventPublisher;
  logger?: Logger;
  clock?: Clock;
  maxAttempts?: number;
}): Outbox {
  return createOutbox({
    db,
    bus: deps.bus,
    clock: deps.clock ?? fixedClock(AT),
    logger: deps.logger ?? recordingLogger(),
    maxAttempts: deps.maxAttempts,
  });
}

/** The single row a test left behind. Throws if the test's premise is wrong. */
function theRow() {
  return prisma.outboxEvent.findFirstOrThrow();
}

describe('the transactional guarantee', () => {
  it('leaves NO event when the transaction that enqueued it rolls back', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await expect(
      uow.run(db, async (tx) => {
        await outbox.enqueue(tx, 'pointBalanceChanged', 7, { userId: 7 });
        throw new Error('the domain write failed after the enqueue');
      }),
    ).rejects.toThrow('the domain write failed after the enqueue');

    // THE headline law of rung 1. The event was written with the caller's `tx`,
    // so it died with the transaction — there is nothing left to deliver, and
    // nothing was delivered. This is precisely what rung 0 cannot give you: a
    // plain `events.publish` after a rolled-back write has already told
    // subscribers about a state that never existed, and their re-fetch then
    // finds nothing.
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(bus.recorded).toEqual([]);
  });

  it('leaves exactly one PENDING event when the transaction commits', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 7, { userId: 7 }));

    const rows = await prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    // Enqueueing is a WRITE, not a publish: the key is already TEXT-encoded, the
    // delivery columns are untouched, and no attempt has been spent.
    expect(rows[0]).toMatchObject({
      topic: 'pointBalanceChanged',
      key: '7',
      payload: { userId: 7 },
      publishedAt: null,
      failedAt: null,
      attempts: 0,
    });
    // The commit alone tells the bus nothing. Delivery is a separate phase, on
    // purpose — that separation is what survives the process dying here.
    expect(bus.recorded).toEqual([]);
  });
});

describe('drain', () => {
  it('publishes each pending row and stamps publishedAt from the injected clock', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 42, { userId: 42 }));
    expect(await outbox.drain()).toBe(1);

    expect(bus.recorded).toEqual([
      { topic: 'pointBalanceChanged', key: 42, payload: { userId: 42 } },
    ]);
    const row = await theRow();
    // The mark is the ONLY record that delivery happened; an unstamped row would
    // be redelivered forever. `AT` (not the wall clock) proves the stamp came
    // from the injected clock, per CONVENTIONS §10 — the service mints the
    // instant, the repo receives it.
    expect(row.publishedAt).toEqual(AT);
    expect(row.failedAt).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('decodes the key back to its DECLARED type, not the text the column stores', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 42, { userId: 42 }));

    // Storage really is TEXT — one column and one index for every topic…
    expect((await theRow()).key).toBe('42');
    await outbox.drain();

    // …and the subscriber really does get back the `number` the topic declared.
    // The round trip through storage is the whole reason `keyKind` exists: a
    // string '42' here would route into a different pubsub channel than a
    // rung-0 publish of the same event, and the two rungs would silently
    // disagree about who receives what.
    expect(typeof bus.recorded[0]?.key).toBe('number');
    expect(bus.recorded.map((event) => event.key)).toEqual([42]);
  });

  it('publishes NOTHING on a second drain', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 9, { userId: 9 }));
    expect(await outbox.drain()).toBe(1);
    expect(await outbox.drain()).toBe(0);

    // At-least-once is the bargain, but a MARKED row must never be re-claimed:
    // the duplicates the design tolerates come from a crash in the window
    // between publish and mark, not from routine re-draining. `attempts` staying
    // at 1 shows the row was not even claimed the second time.
    expect(bus.recorded).toHaveLength(1);
    expect((await theRow()).attempts).toBe(1);
  });

  it('delivers a row that nobody notified it about', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    // Written straight through the repo, exactly as ANOTHER instance's
    // transaction leaves it: this process saw no commit and `notify()` was never
    // called for it.
    await outboxRepo.enqueue(prisma, {
      topic: 'pointBalanceChanged',
      key: '5',
      payload: { userId: 5 },
    });

    // A bare drain still delivers. This is what makes `notify()` an optimization
    // (millisecond instead of up-to-30-second latency) rather than the delivery
    // guarantee — the scheduled `events:outbox:drain` job is the authority, and
    // it is what picks up rows a crash or another instance left behind.
    expect(await outbox.drain()).toBe(1);
    expect(bus.recorded).toEqual([{ topic: 'pointBalanceChanged', key: 5, payload: { userId: 5 } }]);
  });
});

describe('a publish that keeps failing', () => {
  it('commits the attempt anyway, then retires the row once the budget is spent', async () => {
    const bus = failingPublisher();
    const logger = recordingLogger();
    const outbox = makeOutbox({ bus, logger, maxAttempts: 2 });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 3, { userId: 3 }));

    // Turn 1. The attempt is counted INSIDE the claim transaction, which commits
    // before the publish is ever tried — so a publish that throws (or a crash
    // mid-publish) still costs an attempt. Counting it after a successful
    // publish instead would let a poison row retry forever.
    expect(await outbox.drain()).toBe(0);
    expect(await theRow()).toMatchObject({ attempts: 1, publishedAt: null, failedAt: null });

    // Turn 2. Still pending, still retryable: the row is at the budget, not past
    // it, and `failExhausted` uses `>=` on the NEXT turn.
    expect(await outbox.drain()).toBe(0);
    expect(await theRow()).toMatchObject({ attempts: 2, publishedAt: null, failedAt: null });

    // Turn 3. The sweep runs BEFORE the claim, so the exhausted row is stamped
    // and then excluded — retire first, then claim, or a row's last attempt gets
    // claimed and invalidated within the same turn.
    expect(await outbox.drain()).toBe(0);
    const retired = await theRow();
    expect(retired.failedAt).toEqual(AT);
    expect(retired.publishedAt).toBeNull();
    expect(retired.attempts).toBe(2);

    // Turn 4. A retired row costs the drainer nothing: no claim (attempts frozen)
    // and no publish. It stays in the table as the evidence an operator replays.
    expect(await outbox.drain()).toBe(0);
    expect((await theRow()).attempts).toBe(2);
    expect(bus.calls()).toBe(2);
    // Both failures were reported. A drain that gave up in silence would be
    // indistinguishable from one that had nothing to do.
    expect(logger.errors).toHaveLength(2);
  });
});

describe('an unroutable row', () => {
  it('is retired on the FIRST drain instead of burning its attempt budget', async () => {
    const bus = recordingPublisher();
    const logger = recordingLogger();
    // Default budget (6 attempts) on purpose: the point is that six turns are
    // not needed, because no future turn could route this row either.
    const outbox = makeOutbox({ bus, logger });

    // A topic the registry does not have — a deploy removed it, or the column
    // was written by something that bypassed the codec.
    await outboxRepo.enqueue(prisma, {
      topic: 'orderShipped',
      key: '1',
      payload: { orderId: 1 },
    });

    expect(await outbox.drain()).toBe(0);

    const row = await theRow();
    expect(row.failedAt).toEqual(AT);
    expect(row.publishedAt).toBeNull();
    // One claim happened (that is how the row was read at all); what must NOT
    // happen is five more turns of the same futile claim.
    expect(row.attempts).toBe(1);
    expect(bus.recorded).toEqual([]);
    expect(logger.errors).toHaveLength(1);

    // And it stays out of the claim set. A retired row still has attempts to
    // spare (1 of 6), so `failedAt` — not the attempt budget — is what keeps the
    // drainer from picking it up again; a frozen `attempts` is the proof it was
    // never re-claimed. Without that, an unroutable row would cost every future
    // drain a claim, an increment, and a log line, forever.
    expect(await outbox.drain()).toBe(0);
    const stillRetired = await theRow();
    expect(stillRetired.attempts).toBe(1);
    expect(stillRetired.failedAt).toEqual(AT);
    expect(logger.errors).toHaveLength(1);
  });
});

describe('purge', () => {
  it('removes delivered rows past retention and keeps failed ones forever', async () => {
    const bus = recordingPublisher();
    const outbox = makeOutbox({ bus });

    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 1, { userId: 1 }));
    await uow.run(db, (tx) => outbox.enqueue(tx, 'pointBalanceChanged', 2, { userId: 2 }));
    // A third row that can never route, so the drain below retires it.
    await outboxRepo.enqueue(prisma, { topic: 'orderShipped', key: '3', payload: {} });

    expect(await outbox.drain()).toBe(2);

    // Backdate by writing the columns directly: retention is measured against
    // stamps the outbox itself minted, and the fixed clock means the cutoff is
    // an exact instant rather than something the test has to approximate.
    await prisma.outboxEvent.updateMany({
      where: { key: '1' },
      data: { publishedAt: addDays(AT, -30) },
    });
    await prisma.outboxEvent.updateMany({
      where: { key: '3' },
      data: { failedAt: addDays(AT, -30), createdAt: addDays(AT, -30) },
    });

    expect(await outbox.purge()).toBe(1);

    const left = await prisma.outboxEvent.findMany({ orderBy: { key: 'asc' } });
    // Row 2 is inside the window (you still want to answer "did this go out?"
    // during an incident). Row 3 is a MONTH old and still here, because a failed
    // row is the evidence — nothing deletes it, only an operator does.
    expect(left.map((row) => row.key)).toEqual(['2', '3']);
  });

  it('keeps a row published exactly at the cutoff, and removes one an instant older', async () => {
    const outbox = makeOutbox({ bus: recordingPublisher() });
    await outboxRepo.enqueue(prisma, {
      topic: 'pointBalanceChanged',
      key: '1',
      payload: { userId: 1 },
    });

    // The retention comparison is strict (`lt`), and it is computed from the
    // injected clock — `purge()` takes no cutoff precisely so the scheduled job
    // never reads time itself (CONVENTIONS §10).
    await prisma.outboxEvent.updateMany({ data: { publishedAt: CUTOFF } });
    expect(await outbox.purge()).toBe(0);

    await prisma.outboxEvent.updateMany({
      data: { publishedAt: new Date(CUTOFF.getTime() - 1) },
    });
    expect(await outbox.purge()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});
