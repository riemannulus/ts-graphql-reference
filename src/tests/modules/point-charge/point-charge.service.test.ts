import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommissionCheckoutService } from '../../../modules/commission-checkout/commission-checkout.service.js';
import { createPointChargeService } from '../../../modules/point-charge/point-charge.service.js';
import { resetDb, makeTestPrisma } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const db = { rw: prisma, ro: prisma };

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function seedPointAccount() {
  const buyer = await prisma.user.create({ data: { email: 'point-charge-buyer@example.com' } });
  const holder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
  });
  const account = await prisma.financialAccount.create({
    data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  return { buyer, holder, account };
}

async function seedIncompleteChargeOperation(suffix: string) {
  const { buyer, account } = await seedPointAccount();
  const flow = await prisma.transactionFlow.create({
    data: { kind: 'POINT_CHARGE', policies: { create: { commandKind: 'CHARGE' } } },
  });
  const command = await prisma.financialCommandRun.create({
    data: {
      flowId: flow.id,
      flowKind: 'POINT_CHARGE',
      kind: 'CHARGE',
      principalId: buyer.id,
      idempotencyKey: `raw-${suffix}`,
      payloadHash: `raw-${suffix}`,
      subjectNamespace: 'point-charge-payment',
      subjectKey: `pg-payment-raw-${suffix}`,
    },
  });
  const operation = await prisma.financialOperation.create({
    data: { flowId: flow.id, kind: 'CHARGE', originatingCommandId: command.id },
  });
  return { buyer, account, flow, command, operation };
}

describe('PointChargeService.charge', () => {
  it('issues one immutable paid lot and replays both command and payment retries', async () => {
    const { buyer, account } = await seedPointAccount();
    const service = createPointChargeService(db);
    const input = {
      actorId: buyer.id,
      amount: 600,
      externalPaymentId: 'pg-payment-201',
      commandKey: 'charge-201',
    };

    const first = await service.charge(input);
    const commandReplay = await service.charge(input);
    const paymentReplay = await service.charge({ ...input, commandKey: 'charge-201-retry' });

    expect(first).toEqual({
      lotId: 1,
      amount: 600,
      referenceId: expect.stringMatching(/^POINT_CHARGE-[0-9a-f-]{36}$/),
      commandId: expect.stringMatching(/^CMD-CHARGE-[0-9a-f-]{36}$/),
      operationId: expect.stringMatching(/^OP-CHARGE-[0-9a-f-]{36}$/),
      replayed: false,
    });
    expect(commandReplay).toEqual({ ...first, replayed: true });
    expect(paymentReplay).toEqual({ ...first, replayed: true });
    expect(await prisma.financialCommandRun.count()).toBe(1);
    expect(await prisma.financialLot.findUniqueOrThrow({ where: { id: first.lotId } })).toMatchObject({
      accountId: account.id,
      currency: 'POINT',
      sourceKind: 'PAID',
      sourceFlowKind: 'POINT_CHARGE',
      sourceOperationKind: 'CHARGE',
      issuanceReason: 'PURCHASE',
      accountingCategory: 'CUSTOMER_ADVANCE',
      accountingPolicyVersion: 'point-charge-v1',
      originalAmount: 600,
      remainingAmount: 600,
    });
  });

  it('recovers point-charge provenance through a commission allocation', async () => {
    const { buyer } = await seedPointAccount();
    const charge = await createPointChargeService(db).charge({
      actorId: buyer.id,
      amount: 600,
      externalPaymentId: 'pg-payment-202',
      commandKey: 'charge-202',
    });
    const worker = await prisma.user.create({ data: { email: 'point-charge-worker@example.com' } });
    const commissionType = await prisma.commissionType.create({
      data: { workerId: worker.id, title: 'portrait', price: 500 },
    });
    const slot = await prisma.commissionSlot.create({
      data: { workerId: worker.id, state: 'AVAILABLE' },
    });
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    const order = await prisma.order.create({
      data: {
        flowId: flow.id,
        buyerId: buyer.id,
        commissionTypeId: commissionType.id,
        slotId: slot.id,
        titleSnapshot: commissionType.title,
        amount: commissionType.price,
      },
    });
    const payment = await prisma.orderPayment.create({
      data: { orderId: order.id, flowId: flow.id, amount: order.amount },
    });

    const checkout = await createCommissionCheckoutService(db).complete({
      orderPaymentId: payment.id,
      actorId: buyer.id,
      commandKey: 'commission-pay-202',
    });
    const sources = await createPointChargeService(db).traceCommissionFunding(
      checkout.reservationId,
    );

    expect(sources).toEqual([
      {
        lotId: charge.lotId,
        operationId: charge.operationId.slice('OP-CHARGE-'.length),
        flowId: charge.referenceId.slice('POINT_CHARGE-'.length),
        amount: 500,
        issuanceReason: 'PURCHASE',
        accountingCategory: 'CUSTOMER_ADVANCE',
        accountingPolicyVersion: 'point-charge-v1',
        referenceId: charge.referenceId,
        operationReferenceId: charge.operationId,
      },
    ]);
  });

  it('rejects changing immutable accounting classification', async () => {
    const { buyer } = await seedPointAccount();
    const charge = await createPointChargeService(db).charge({
      actorId: buyer.id,
      amount: 600,
      externalPaymentId: 'pg-payment-203',
      commandKey: 'charge-203',
    });

    await expect(
      prisma.financialLot.update({
        where: { id: charge.lotId },
        data: { accountingCategory: 'ADVERTISEMENT' },
      }),
    ).rejects.toThrow(/FinancialLot_basis_immutable/);
  });

  it('rejects replaying a payment with a different economic payload', async () => {
    const { buyer } = await seedPointAccount();
    const service = createPointChargeService(db);
    const input = {
      actorId: buyer.id,
      amount: 600,
      externalPaymentId: 'pg-payment-204',
      commandKey: 'charge-204',
    };
    await service.charge(input);

    await expect(
      service.charge({ ...input, amount: 700, commandKey: 'charge-204-retry' }),
    ).rejects.toThrow(/identity mismatch/);
    expect(await prisma.financialLot.count()).toBe(1);
  });

  it('rejects a completed CHARGE command without its typed lot effect', async () => {
    const { buyer } = await seedPointAccount();

    await expect(
      prisma.$transaction(async (tx) => {
        const flow = await tx.transactionFlow.create({
          data: { kind: 'POINT_CHARGE', policies: { create: { commandKind: 'CHARGE' } } },
        });
        const command = await tx.financialCommandRun.create({
          data: {
            flowId: flow.id,
            flowKind: 'POINT_CHARGE',
            kind: 'CHARGE',
            principalId: buyer.id,
            idempotencyKey: 'counterfeit-charge',
            payloadHash: 'counterfeit',
            subjectNamespace: 'point-charge-payment',
            subjectKey: 'pg-payment-counterfeit',
          },
        });
        const operation = await tx.financialOperation.create({
          data: {
            flowId: flow.id,
            kind: 'CHARGE',
            originatingCommandId: command.id,
          },
        });
        await tx.financialCommandRun.update({
          where: { id: command.id },
          data: { resultOperationId: operation.id },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "FinancialCommand_effect_completeness_check" IMMEDIATE',
        );
      }),
    ).rejects.toThrow(/has no typed financial effect/);
  });

  it('rejects a provenance lot with omitted nullable accounting basis', async () => {
    const world = await seedIncompleteChargeOperation('missing-basis');

    await expect(
      prisma.financialLot.create({
        data: {
          accountId: world.account.id,
          currency: 'POINT',
          sourceKind: 'PAID',
          sourceOperationId: world.operation.id,
          sourceFlowId: world.flow.id,
          originalAmount: 100,
          remainingAmount: 100,
        },
      }),
    ).rejects.toThrow(/FinancialLot_source_check/);
  });

  it('rejects a point-charge lot whose originating command is not completed', async () => {
    const world = await seedIncompleteChargeOperation('incomplete-command');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.financialLot.create({
          data: {
            accountId: world.account.id,
            currency: 'POINT',
            sourceKind: 'PAID',
            sourceOperationId: world.operation.id,
            sourceFlowId: world.flow.id,
            sourceFlowKind: 'POINT_CHARGE',
            sourceOperationKind: 'CHARGE',
            issuanceReason: 'PURCHASE',
            accountingCategory: 'CUSTOMER_ADVANCE',
            accountingPolicyVersion: 'point-charge-v1',
            originalAmount: 100,
            remainingAmount: 100,
          },
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "FinancialLot_point_charge_shape_check" IMMEDIATE',
        );
      }),
    ).rejects.toThrow(/must be issued by one completed POINT_CHARGE command/);
  });

  it('rejects a second CHARGE lot in the same POINT_CHARGE flow', async () => {
    const { buyer, account } = await seedPointAccount();
    const charge = await createPointChargeService(db).charge({
      actorId: buyer.id,
      amount: 100,
      externalPaymentId: 'pg-payment-one-lot',
      commandKey: 'one-lot',
    });
    const flowId = charge.referenceId.slice('POINT_CHARGE-'.length);

    await expect(
      prisma.$transaction(async (tx) => {
        const command = await tx.financialCommandRun.create({
          data: {
            flowId,
            flowKind: 'POINT_CHARGE',
            kind: 'CHARGE',
            principalId: buyer.id,
            idempotencyKey: 'second-lot',
            payloadHash: 'second-lot',
            subjectNamespace: 'point-charge-payment',
            subjectKey: 'pg-payment-second-lot',
          },
        });
        const operation = await tx.financialOperation.create({
          data: { flowId, kind: 'CHARGE', originatingCommandId: command.id },
        });
        await tx.financialCommandRun.update({
          where: { id: command.id },
          data: { resultOperationId: operation.id },
        });
        await tx.financialLot.create({
          data: {
            accountId: account.id,
            currency: 'POINT',
            sourceKind: 'PAID',
            sourceOperationId: operation.id,
            sourceFlowId: flowId,
            sourceFlowKind: 'POINT_CHARGE',
            sourceOperationKind: 'CHARGE',
            issuanceReason: 'PURCHASE',
            accountingCategory: 'CUSTOMER_ADVANCE',
            accountingPolicyVersion: 'point-charge-v1',
            originalAmount: 100,
            remainingAmount: 100,
          },
        });
      }),
    ).rejects.toThrow(/FinancialLot_point_charge_flow_key|Unique constraint/);
    expect(await prisma.financialLot.count()).toBe(1);
  });
});
