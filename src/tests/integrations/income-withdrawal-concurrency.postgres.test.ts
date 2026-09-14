import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../db/prisma.js';
import { createCommissionCheckoutService } from '../../modules/commission-checkout/commission-checkout.service.js';
import { createCommissionSettlementService } from '../../modules/commission-settlement/commission-settlement.service.js';
import { IncomeWithdrawalAmountError } from '../../modules/income-withdrawal/income-withdrawal.core.js';
import { createIncomeWithdrawalService } from '../../modules/income-withdrawal/income-withdrawal.service.js';
import { resetDb } from '../support/helpers.js';

const databaseUrl = process.env.INCOME_FLOW_RACE_DATABASE_URL;
const first = databaseUrl ? createPrismaClient(databaseUrl) : null;
const second = databaseUrl ? createPrismaClient(databaseUrl) : null;

beforeEach(async () => {
  if (first) await resetDb(first);
});

afterAll(async () => {
  await Promise.all([first?.$disconnect(), second?.$disconnect()]);
});

function requireClients() {
  if (!first || !second) throw new Error('INCOME_FLOW_RACE_DATABASE_URL is required');
  return { first, second };
}

async function seedWithdrawableIncome() {
  const clients = requireClients();
  const worker = await clients.first.user.create({
    data: { email: 'income-race-worker@example.com' },
  });
  const buyer = await clients.first.user.create({
    data: { email: 'income-race-buyer@example.com' },
  });
  const workerHolder = await clients.first.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(worker.id) },
  });
  await clients.first.financialAccount.create({
    data: { holderId: workerHolder.id, currency: 'INCOME', purpose: 'AVAILABLE' },
  });
  const buyerHolder = await clients.first.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const buyerAvailable = await clients.first.financialAccount.create({
    data: { holderId: buyerHolder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  await clients.first.financialLot.create({
    data: { accountId: buyerAvailable.id, sourceKind: 'PAID', originalAmount: 100, remainingAmount: 100 },
  });
  const platform = await clients.first.financialHolder.create({
    data: { bindingNamespace: 'system', bindingKey: 'platform' },
  });
  await clients.first.financialAccount.createMany({
    data: [
      { holderId: platform.id, currency: 'POINT', purpose: 'SETTLED' },
      { holderId: platform.id, currency: 'INCOME', purpose: 'ISSUER' },
    ],
  });
  const commissionType = await clients.first.commissionType.create({
    data: { workerId: worker.id, title: 'race', price: 100 },
  });
  const slot = await clients.first.commissionSlot.create({
    data: { workerId: worker.id, state: 'AVAILABLE' },
  });
  const flow = await clients.first.transactionFlow.create({
    data: {
      kind: 'COMMISSION',
      policies: { createMany: { data: [{ commandKind: 'PAY' }, { commandKind: 'SETTLE' }] } },
    },
  });
  const order = await clients.first.order.create({
    data: {
      flowId: flow.id,
      buyerId: buyer.id,
      commissionTypeId: commissionType.id,
      slotId: slot.id,
      titleSnapshot: commissionType.title,
      amount: 100,
    },
  });
  const payment = await clients.first.orderPayment.create({
    data: { orderId: order.id, flowId: flow.id, amount: 100 },
  });
  const checkout = await createCommissionCheckoutService({
    rw: clients.first,
    ro: clients.first,
  }).complete({
    orderPaymentId: payment.id,
    actorId: buyer.id,
    commandKey: 'race-pay',
  });
  const settlement = await createCommissionSettlementService({
    rw: clients.first,
    ro: clients.first,
  }).settle({
    contractId: checkout.contractId,
    actorId: worker.id,
    commandKey: 'race-settle',
  });
  expect(settlement).toMatchObject({
    referenceId: expect.stringMatching(/^COMMISSION-[0-9a-f-]{36}$/),
    commandId: expect.stringMatching(/^CMD-SETTLE-[0-9a-f-]{36}$/),
    operationId: expect.stringMatching(/^OP-SETTLE-[0-9a-f-]{36}$/),
    replayed: false,
  });
  const lot = await clients.first.financialLot.findUniqueOrThrow({
    where: { id: settlement.incomeLotId },
  });
  return { worker, lot };
}

describe.skipIf(!databaseUrl)('INCOME withdrawal concurrency on PostgreSQL', () => {
  it('allows only one of two withdrawals that compete for the same INCOME', async () => {
    const clients = requireClients();
    const world = await seedWithdrawableIncome();
    await clients.first.$executeRawUnsafe(`
      CREATE FUNCTION pause_first_withdrawal_flow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."kind" = 'WITHDRAWAL' THEN PERFORM pg_sleep(0.25); END IF;
        RETURN NEW;
      END;
      $$
    `);
    await clients.first.$executeRawUnsafe(`
      CREATE TRIGGER pause_first_withdrawal_flow
      BEFORE INSERT ON "TransactionFlow"
      FOR EACH ROW EXECUTE FUNCTION pause_first_withdrawal_flow()
    `);
    const firstRequest = createIncomeWithdrawalService({ rw: clients.first, ro: clients.first }).request({
        actorId: world.worker.id,
        amount: 80,
        commandKey: 'race-first',
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondRequest = createIncomeWithdrawalService({ rw: clients.second, ro: clients.second }).request({
        actorId: world.worker.id,
        amount: 80,
        commandKey: 'race-second',
      });
    const outcomes = await Promise.allSettled([firstRequest, secondRequest]);
    await clients.first.$executeRawUnsafe('DROP TRIGGER pause_first_withdrawal_flow ON "TransactionFlow"');
    await clients.first.$executeRawUnsafe('DROP FUNCTION pause_first_withdrawal_flow()');

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(IncomeWithdrawalAmountError);
    expect(await clients.first.financialWithdrawal.count()).toBe(1);
    expect(await clients.first.financialLot.findUniqueOrThrow({ where: { id: world.lot.id } }))
      .toMatchObject({ remainingAmount: 20 });
  });
});
