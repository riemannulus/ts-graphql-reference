import { fc, test } from '@fast-check/vitest';
import { afterAll, beforeEach, expect } from 'vitest';
import { createPointService } from '../../../modules/point/point.service.js';
import { InsufficientPointError } from '../../../modules/point/point.core.js';
import { arbChargeInput } from './point.arbitraries.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const points = createPointService({ rw: prisma, ro: prisma });

/**
 * Model-based test: a random sequence of charge/spend operations is replayed
 * against both a tiny in-memory ledger model (paid/free running totals, spent
 * paid-first) and the real service + DB. After every command it asserts they
 * never diverge AND that the DB ledger is internally consistent — the unspent
 * remainders across all charges always sum back to the balance. That invariant
 * is what a persistence bug in applyChargePlan / applySpendPlan (a mis-guarded
 * decrement, a wrong depletion) would break, which the fixed-sequence example
 * tests cannot exhaust the way random charge→spend→charge histories do.
 */
interface Model {
  paid: number;
  free: number;
}
interface Real {
  userId: number;
}

async function assertLedgerConsistent(userId: number, model: Model): Promise<void> {
  const balance = await prisma.pointBalance.findUnique({ where: { userId } });
  const paid = balance?.paidAmount ?? 0;
  const free = balance?.freeAmount ?? 0;
  // The balance matches the spec model.
  expect({ paid, free, total: balance?.totalAmount ?? 0 }).toEqual({
    paid: model.paid,
    free: model.free,
    total: model.paid + model.free,
  });
  // The denormalized balance still equals the charge ledger it summarizes.
  const charges = await prisma.pointCharge.findMany({ where: { userId } });
  const unspentPaid = charges.reduce((sum, c) => sum + c.unspentPaidAmount, 0);
  const unspentFree = charges.reduce((sum, c) => sum + c.unspentFreeAmount, 0);
  expect({ unspentPaid, unspentFree }).toEqual({ unspentPaid: model.paid, unspentFree: model.free });
}

class ChargeCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly paidAmount: number,
    private readonly freeAmount: number,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    await points.charge(real.userId, { paidAmount: this.paidAmount, freeAmount: this.freeAmount });
    model.paid += this.paidAmount;
    model.free += this.freeAmount;
    await assertLedgerConsistent(real.userId, model);
  }

  toString(): string {
    return `charge(${this.paidAmount}p, ${this.freeAmount}f)`;
  }
}

class SpendCommand implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly amount: number) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    if (this.amount <= model.paid + model.free) {
      await points.spend(real.userId, { amount: this.amount, reason: 'model' });
      const paidSpent = Math.min(this.amount, model.paid);
      model.paid -= paidSpent;
      model.free -= this.amount - paidSpent;
    } else {
      await expect(
        points.spend(real.userId, { amount: this.amount, reason: 'model' }),
      ).rejects.toBeInstanceOf(InsufficientPointError);
      // an over-balance spend must leave the ledger untouched
    }
    await assertLedgerConsistent(real.userId, model);
  }

  toString(): string {
    return `spend(${this.amount})`;
  }
}

const commands = [
  arbChargeInput.map((input) => new ChargeCommand(input.paidAmount, input.freeAmount)),
  fc.integer({ min: 1, max: 300 }).map((amount) => new SpendCommand(amount)),
];

let seq = 0;
beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

test.prop([fc.commands(commands, { size: '+1' })])(
  'point service ledger stays consistent with the paid-first model',
  async (cmds) => {
    const user = await prisma.user.create({ data: { email: `pmodel-${seq++}@example.com` } });
    await fc.asyncModelRun(() => ({ model: { paid: 0, free: 0 }, real: { userId: user.id } }), cmds);
  },
  30_000, // 100 runs × several commands × real DB round-trips
);
