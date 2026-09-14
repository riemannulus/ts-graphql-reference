import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// The DB-side halves of invariants whose other half lives in code. The code
// keeps the single source of truth for *rules* (transitions, plans); these
// CHECK constraints guarantee the *value sets and signs* survive even a buggy
// or bypassing writer. Raw SQL is used on purpose — the point is that the
// database itself refuses, with no application layer in the way.
const prisma = await makeTestPrisma();

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

async function makeUser(): Promise<number> {
  const user = await prisma.user.create({ data: { email: 'checks@example.com' } });
  return user.id;
}

async function makeFinancialWorld(opts: { targetAmount?: number } = {}) {
  const principal = await prisma.user.create({ data: { email: 'ledger-checks@example.com' } });
  const flow = await prisma.transactionFlow.create({
    data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
  });
  const command = await prisma.financialCommandRun.create({
    data: {
      flowId: flow.id,
      flowKind: 'COMMISSION',
      kind: 'PAY',
      principalId: principal.id,
      idempotencyKey: 'ledger-check',
      payloadHash: 'test',
      subjectNamespace: 'test',
      subjectKey: 'ledger',
    },
  });
  const operation = await prisma.financialOperation.create({
    data: { flowId: flow.id, kind: 'PAY', originatingCommandId: command.id },
  });
  const action = await prisma.financialTransferAction.create({
    data: { operationId: operation.id, flowId: flow.id },
  });
  const holder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: 'ledger-owner' },
  });
  const otherHolder = await prisma.financialHolder.create({
    data: { bindingNamespace: 'user', bindingKey: 'other-owner' },
  });
  const available = await prisma.financialAccount.create({
    data: { holderId: holder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  const otherAvailable = await prisma.financialAccount.create({
    data: { holderId: otherHolder.id, currency: 'POINT', purpose: 'AVAILABLE' },
  });
  const reservation = await prisma.financialReservation.create({
    data: {
      flowId: flow.id,
      bindingNamespace: 'order-payment',
      bindingKey: 'ledger',
      holderId: holder.id,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      targetAmount: opts.targetAmount ?? 100,
    },
  });
  const escrow = await prisma.financialAccount.create({
    data: { reservationId: reservation.id, currency: 'POINT', purpose: 'ESCROW' },
  });
  const lot = await prisma.pointLot.create({
    data: {
      accountId: available.id,
      sourceKind: 'PAID',
      originalAmount: 100,
      remainingAmount: 100,
    },
  });
  const otherLot = await prisma.pointLot.create({
    data: {
      accountId: otherAvailable.id,
      sourceKind: 'PAID',
      originalAmount: 100,
      remainingAmount: 100,
    },
  });
  return {
    flow,
    command,
    operation,
    action,
    holder,
    available,
    otherAvailable,
    reservation,
    escrow,
    lot,
    otherLot,
  };
}

async function makeCommittedTransfer() {
  const world = await makeFinancialWorld();
  await prisma.$transaction(async (tx) => {
    await tx.pointLot.update({ where: { id: world.lot.id }, data: { remainingAmount: 0 } });
    const transfer = await tx.financialTransfer.create({
      data: {
        reservationId: world.reservation.id,
        flowId: world.flow.id,
        fromAccountId: world.available.id,
        toAccountId: world.escrow.id,
        amount: 100,
        actionId: world.action.id,
      },
    });
    await tx.financialTransferAllocation.create({
      data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
    });
  });
  return world;
}

describe('database CHECK constraints', () => {
  it('rejects an out-of-set user status (in sync with USER_STATUSES)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "User" ("email", "status", "updatedAt")
        VALUES ('bad@example.com', 'CORRUPTED', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/User_status_check/);
  });

  it('rejects an out-of-set point charge state (in sync with POINT_CHARGE_STATES)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "state", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 'REFUNDED', 10, 0, 10, 0)`,
    ).rejects.toThrow(/PointCharge_state_check/);
  });

  it('accepts the EXPIRED charge state (added to POINT_CHARGE_STATES for point expiry)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "state", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount", "expiredAt")
        VALUES (${userId}, 'EXPIRED', 10, 0, 0, 0, CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
  });

  it('rejects a negative unspent amount on a charge (no persistable overdraft)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 10, 0, -1, 0)`,
    ).rejects.toThrow(/PointCharge_unspentPaidAmount_check/);
  });

  it('rejects a negative balance', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointBalance"
        ("userId", "paidAmount", "freeAmount", "totalAmount", "updatedAt")
        VALUES (${userId}, -1, 0, 0, CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/PointBalance_paidAmount_check/);
  });

  it('rejects an unspent remainder larger than what was charged (no inflation)', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointCharge"
        ("userId", "paidAmount", "freeAmount", "unspentPaidAmount", "unspentFreeAmount")
        VALUES (${userId}, 10, 0, 11, 0)`,
    ).rejects.toThrow(/PointCharge_unspentPaidAmount_check/);
  });

  it('rejects a spend whose total does not equal paid + free', async () => {
    const userId = await makeUser();
    await expect(
      prisma.$executeRaw`INSERT INTO "PointSpend"
        ("userId", "paidAmount", "freeAmount", "totalAmount", "reason")
        VALUES (${userId}, 10, 5, 14, 'inconsistent')`,
    ).rejects.toThrow(/PointSpend_totalAmount_check/);
  });

  it('rejects an out-of-set feature-flag stage (in sync with STAGES)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('f', 'STAGING', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_stage_check/);
  });

  it('accepts a NULL stage and every known stage', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('none', NULL, CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
    await Promise.all(
      ['LOCAL', 'DEV', 'QA', 'STG', 'PROD'].map((stage) =>
        expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt") VALUES ('flag_${stage}', '${stage}', CURRENT_TIMESTAMP)`,
          ),
        ).resolves.toBe(1),
      ),
    );
  });

  it('rejects a command kind outside the COMMISSION vocabulary', async () => {
    const principalId = await makeUser();
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    await expect(
      prisma.$executeRaw`
        INSERT INTO "FinancialCommandRun"
          ("id", "flowId", "flowKind", "kind", "principalId", "idempotencyKey", "payloadHash", "subjectNamespace", "subjectKey")
        VALUES
          ('00000000-0000-4000-8000-000000000001'::uuid, ${flow.id}::uuid, 'COMMISSION', 'WITHDRAW_FINAL', ${principalId}, 'bad-kind', 'test', 'test', '1')
      `,
    ).rejects.toThrow(/invalid input value for enum "FinancialCommandKind"/);
  });

  it('rejects an operation whose kind differs from its originating command', async () => {
    const principalId = await makeUser();
    const flow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    const command = await prisma.financialCommandRun.create({
      data: {
        flowId: flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId,
        idempotencyKey: 'pay-kind',
        payloadHash: 'test',
        subjectNamespace: 'test',
        subjectKey: '1',
      },
    });
    await expect(
      prisma.financialOperation.create({
        data: { flowId: flow.id, kind: 'SETTLE', originatingCommandId: command.id },
      }),
    ).rejects.toThrow(/FinancialOperation_originatingCommandId_flowId_kind_fkey/);
  });

  it('rejects a command that its flow did not explicitly allow', async () => {
    const principalId = await makeUser();
    const flow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    await expect(
      prisma.financialCommandRun.create({
        data: {
          flowId: flow.id,
          flowKind: 'COMMISSION',
          kind: 'PAY',
          principalId,
          idempotencyKey: 'not-allowed',
          payloadHash: 'test',
          subjectNamespace: 'test',
          subjectKey: '1',
        },
      }),
    ).rejects.toThrow(/FinancialCommandRun_flowId_kind_fkey/);
  });

  it('rejects a transfer action from a different flow', async () => {
    const world = await makeFinancialWorld();
    const otherPrincipal = await prisma.user.create({ data: { email: 'other-flow@example.com' } });
    const otherFlow = await prisma.transactionFlow.create({
      data: { kind: 'COMMISSION', policies: { create: { commandKind: 'PAY' } } },
    });
    const otherCommand = await prisma.financialCommandRun.create({
      data: {
        flowId: otherFlow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: otherPrincipal.id,
        idempotencyKey: 'other-flow',
        payloadHash: 'test',
        subjectNamespace: 'test',
        subjectKey: 'other',
      },
    });
    const otherOperation = await prisma.financialOperation.create({
      data: { flowId: otherFlow.id, kind: 'PAY', originatingCommandId: otherCommand.id },
    });
    const otherAction = await prisma.financialTransferAction.create({
      data: { flowId: otherFlow.id, operationId: otherOperation.id },
    });

    await expect(
      prisma.financialTransfer.create({
        data: {
          reservationId: world.reservation.id,
          flowId: world.flow.id,
          fromAccountId: world.available.id,
          toAccountId: world.escrow.id,
          amount: 100,
          actionId: otherAction.id,
        },
      }),
    ).rejects.toThrow(/FinancialTransfer_actionId_flowId_fkey/);
  });

  it('rejects linking an Order payment to a reservation from another flow', async () => {
    const buyer = await prisma.user.create({ data: { email: 'flow-link-buyer@example.com' } });
    const worker = await prisma.user.create({ data: { email: 'flow-link-worker@example.com' } });
    const commissionType = await prisma.commissionType.create({
      data: { workerId: worker.id, title: 'flow link', price: 100 },
    });
    const slot = await prisma.commissionSlot.create({ data: { workerId: worker.id } });
    const orderFlow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const reservationFlow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const order = await prisma.order.create({
      data: {
        flowId: orderFlow.id,
        buyerId: buyer.id,
        commissionTypeId: commissionType.id,
        slotId: slot.id,
        titleSnapshot: commissionType.title,
        amount: commissionType.price,
      },
    });
    await expect(
      prisma.order.update({ where: { id: order.id }, data: { flowId: reservationFlow.id } }),
    ).rejects.toThrow(/Order_flow_immutable/);
    const payment = await prisma.orderPayment.create({
      data: { orderId: order.id, flowId: orderFlow.id, amount: order.amount },
    });
    const holder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: String(buyer.id) },
    });
    const reservation = await prisma.financialReservation.create({
      data: {
        flowId: reservationFlow.id,
        bindingNamespace: 'commission-order-payment',
        bindingKey: String(payment.id),
        holderId: holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });

    await expect(
      prisma.orderFinancialLink.create({
        data: { orderPaymentId: payment.id, flowId: orderFlow.id, reservationId: reservation.id },
      }),
    ).rejects.toThrow(/OrderFinancialLink_reservationId_flowId_fkey/);
  });

  it('rejects a feature-flag window that ends before it starts', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "enableAfter", "disableAfter", "updatedAt")
        VALUES ('f', 'PROD', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_window_check/);
  });

  it('accepts an equal-bounds feature-flag window (the bound is inclusive)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "enableAfter", "disableAfter", "updatedAt")
        VALUES ('eq', 'PROD', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
  });

  it('rejects a second LIVE row of the same name (one live flag per name)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('dup', 'PROD', CURRENT_TIMESTAMP)`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`INSERT INTO "FeatureFlag" ("name", "stage", "updatedAt")
        VALUES ('dup', 'DEV', CURRENT_TIMESTAMP)`,
    ).rejects.toThrow(/FeatureFlag_name_live_key/);
  });

  it('rejects reusing one financial reservation binding', async () => {
    const flow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const holderId = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialHolder" ("bindingNamespace", "bindingKey")
      VALUES ('user', '1') RETURNING "id"
    `;
    await prisma.$executeRaw`
      INSERT INTO "FinancialReservation"
        ("flowId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
      VALUES (${flow.id}::uuid, 'order-payment', '1', ${holderId[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "FinancialReservation"
          ("flowId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
        VALUES (${flow.id}::uuid, 'order-payment', '1', ${holderId[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
      `,
    ).rejects.toThrow(/FinancialReservation_bindingNamespace_bindingKey_key/);
  });

  it('rejects forming two contracts from one order', async () => {
    const flow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const buyerId = await makeUser();
    const worker = await prisma.user.create({ data: { email: 'worker-checks@example.com' } });
    const commissionType = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "CommissionType" ("workerId", "title", "price")
      VALUES (${worker.id}, 'portrait', 100) RETURNING "id"
    `;
    const slot = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "CommissionSlot" ("workerId") VALUES (${worker.id}) RETURNING "id"
    `;
    const order = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "Order" ("buyerId", "commissionTypeId", "slotId", "flowId", "titleSnapshot", "amount", "updatedAt")
      VALUES (${buyerId}, ${commissionType[0]!.id}, ${slot[0]!.id}, ${flow.id}::uuid, 'portrait', 100, CURRENT_TIMESTAMP) RETURNING "id"
    `;
    await prisma.$executeRaw`
      INSERT INTO "Contract" ("orderId", "flowId", "buyerId", "workerId")
      VALUES (${order[0]!.id}, ${flow.id}::uuid, ${buyerId}, ${worker.id})
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "Contract" ("orderId", "flowId", "buyerId", "workerId")
        VALUES (${order[0]!.id}, ${flow.id}::uuid, ${buyerId}, ${worker.id})
      `,
    ).rejects.toThrow(/Contract_orderId_key/);
  });

  it('rejects a financial account with both holder and reservation ownership', async () => {
    const flow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    const holder = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialHolder" ("bindingNamespace", "bindingKey")
      VALUES ('user', 'account-owner') RETURNING "id"
    `;
    const reservation = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "FinancialReservation"
        ("flowId", "bindingNamespace", "bindingKey", "holderId", "purpose", "currency", "targetAmount")
      VALUES (${flow.id}::uuid, 'order-payment', 'account', ${holder[0]!.id}, 'COMMISSION_PAYMENT', 'POINT', 100)
      RETURNING "id"
    `;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "FinancialAccount" ("currency", "purpose", "holderId", "reservationId")
        VALUES ('POINT', 'AVAILABLE', ${holder[0]!.id}, ${reservation[0]!.id})
      `,
    ).rejects.toThrow(/FinancialAccount_owner_check/);
  });

  it('rejects a transfer whose amount differs from its reservation target', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 99,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 99 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects a transfer sourced from another holder', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.otherAvailable.id,
            toAccountId: world.escrow.id,
            amount: 100,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.otherLot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects a transfer sent to another reservation escrow account', async () => {
    const world = await makeFinancialWorld();
    const otherReservation = await prisma.financialReservation.create({
      data: {
        flowId: world.flow.id,
        bindingNamespace: 'order-payment',
        bindingKey: 'other-escrow',
        holderId: world.holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });
    const otherEscrow = await prisma.financialAccount.create({
      data: {
        reservationId: otherReservation.id,
        currency: 'POINT',
        purpose: 'ESCROW',
      },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: otherEscrow.id,
            amount: 100,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects transfer allocations whose sum differs from the transfer amount', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 99 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects an allocation from a lot outside the transfer source account', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.otherLot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/FinancialTransfer_conservation_check/);
  });

  it('rejects an allocation that leaves the same value spendable in its source lot', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 100,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 100 },
        });
      }),
    ).rejects.toThrow(/PointLot_conservation_check/);
  });

  it('rejects allocating more than the source lot originally contained', async () => {
    const world = await makeFinancialWorld({ targetAmount: 101 });
    await expect(
      prisma.$transaction(async (tx) => {
        const transfer = await tx.financialTransfer.create({
          data: {
            reservationId: world.reservation.id,
            flowId: world.flow.id,
            fromAccountId: world.available.id,
            toAccountId: world.escrow.id,
            amount: 101,
            actionId: world.action.id,
          },
        });
        await tx.financialTransferAllocation.create({
          data: { transferId: transfer.id, lotId: world.lot.id, amount: 101 },
        });
      }),
    ).rejects.toThrow(/PointLot_conservation_check/);
  });

  it('rejects changing a reservation amount after its transfer is committed', async () => {
    const world = await makeCommittedTransfer();
    await expect(
      prisma.financialReservation.update({
        where: { id: world.reservation.id },
        data: { targetAmount: 99 },
      }),
    ).rejects.toThrow(/FinancialReservation_basis_immutable/);
  });

  it('rejects moving an allocated lot to a different account', async () => {
    const world = await makeCommittedTransfer();
    await expect(
      prisma.pointLot.update({
        where: { id: world.lot.id },
        data: { accountId: world.otherAvailable.id },
      }),
    ).rejects.toThrow(/PointLot_basis_immutable/);
  });

  it('rejects changing ownership of an account used by a committed transfer', async () => {
    const world = await makeCommittedTransfer();
    const replacementHolder = await prisma.financialHolder.create({
      data: { bindingNamespace: 'user', bindingKey: 'replacement-owner' },
    });
    await expect(
      prisma.financialAccount.update({
        where: { id: world.available.id },
        data: { holderId: replacementHolder.id },
      }),
    ).rejects.toThrow(/FinancialAccount_basis_immutable/);
  });

  it('rejects changing an immutable reservation binding', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.financialReservation.update({
        where: { id: world.reservation.id },
        data: { bindingKey: 'changed' },
      }),
    ).rejects.toThrow(/FinancialReservation_basis_immutable/);
  });

  it('rejects moving a reservation to another flow', async () => {
    const world = await makeFinancialWorld();
    const otherFlow = await prisma.transactionFlow.create({ data: { kind: 'COMMISSION' } });
    await expect(
      prisma.financialReservation.update({
        where: { id: world.reservation.id },
        data: { flowId: otherFlow.id },
      }),
    ).rejects.toThrow(/FinancialReservation_basis_immutable/);
  });

  it('allows one command result link and then freezes the command history', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.financialCommandRun.update({
        where: { id: world.command.id },
        data: { payloadHash: 'rewritten' },
      }),
    ).rejects.toThrow(/FinancialCommandRun_append_only/);

    await expect(
      prisma.financialCommandRun.update({
        where: { id: world.command.id },
        data: { resultOperationId: world.operation.id },
      }),
    ).resolves.toMatchObject({ resultOperationId: world.operation.id });
    await expect(
      prisma.financialCommandRun.update({
        where: { id: world.command.id },
        data: { resultOperationId: world.operation.id },
      }),
    ).rejects.toThrow(/FinancialCommandRun_append_only/);

    const alias = await prisma.financialCommandRun.create({
      data: {
        flowId: world.flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: world.command.principalId,
        idempotencyKey: 'alias-delete',
        payloadHash: world.command.payloadHash,
        subjectNamespace: world.command.subjectNamespace,
        subjectKey: world.command.subjectKey,
        resultOperationId: world.operation.id,
      },
    });
    await expect(
      prisma.financialCommandRun.delete({ where: { id: alias.id } }),
    ).rejects.toThrow(/FinancialCommandRun_append_only/);
  });

  it('rejects returning another command\'s operation', async () => {
    const world = await makeFinancialWorld();
    const otherCommand = await prisma.financialCommandRun.create({
      data: {
        flowId: world.flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: world.command.principalId,
        idempotencyKey: 'other-origin',
        payloadHash: 'other',
        subjectNamespace: 'test',
        subjectKey: 'other-origin',
      },
    });
    const otherOperation = await prisma.financialOperation.create({
      data: {
        flowId: world.flow.id,
        kind: 'PAY',
        originatingCommandId: otherCommand.id,
      },
    });

    await expect(
      prisma.financialCommandRun.update({
        where: { id: world.command.id },
        data: { resultOperationId: otherOperation.id },
      }),
    ).rejects.toThrow(/FinancialCommandRun_result_origin_mismatch/);
  });

  it('rejects originating an operation from an alias command', async () => {
    const world = await makeFinancialWorld();
    const alias = await prisma.financialCommandRun.create({
      data: {
        flowId: world.flow.id,
        flowKind: 'COMMISSION',
        kind: 'PAY',
        principalId: world.command.principalId,
        idempotencyKey: 'alias-origin',
        payloadHash: world.command.payloadHash,
        subjectNamespace: world.command.subjectNamespace,
        subjectKey: world.command.subjectKey,
        resultOperationId: world.operation.id,
      },
    });

    await expect(
      prisma.financialOperation.create({
        data: { flowId: world.flow.id, kind: 'PAY', originatingCommandId: alias.id },
      }),
    ).rejects.toThrow(/FinancialOperation_alias_origin/);
  });

  it('rejects rewriting or deleting operation and transfer-action history', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.financialOperation.update({
        where: { id: world.operation.id },
        data: { postedAt: new Date(0) },
      }),
    ).rejects.toThrow(/FinancialOperation_append_only/);
    await expect(
      prisma.financialTransferAction.delete({ where: { id: world.action.id } }),
    ).rejects.toThrow(/FinancialTransferAction_append_only/);
  });

  it('rejects reassigning an append-only transfer to another reservation', async () => {
    const world = await makeCommittedTransfer();
    const otherReservation = await prisma.financialReservation.create({
      data: {
        flowId: world.flow.id,
        bindingNamespace: 'order-payment',
        bindingKey: 'reassignment-target',
        holderId: world.holder.id,
        purpose: 'COMMISSION_PAYMENT',
        currency: 'POINT',
        targetAmount: 100,
      },
    });
    const otherEscrow = await prisma.financialAccount.create({
      data: { reservationId: otherReservation.id, currency: 'POINT', purpose: 'ESCROW' },
    });
    const transfer = await prisma.financialTransfer.findUniqueOrThrow({
      where: { reservationId: world.reservation.id },
    });
    await expect(
      prisma.financialTransfer.update({
        where: { id: transfer.id },
        data: { reservationId: otherReservation.id, toAccountId: otherEscrow.id },
      }),
    ).rejects.toThrow(/FinancialTransfer_append_only/);
  });

  it('rejects rewriting or deleting an append-only transfer allocation', async () => {
    const world = await makeCommittedTransfer();
    const transfer = await prisma.financialTransfer.findUniqueOrThrow({
      where: { reservationId: world.reservation.id },
    });
    const where = { transferId_lotId: { transferId: transfer.id, lotId: world.lot.id } };
    await expect(
      prisma.financialTransferAllocation.update({ where, data: { amount: 99 } }),
    ).rejects.toThrow(/FinancialTransferAllocation_append_only/);
    await expect(prisma.financialTransferAllocation.delete({ where })).rejects.toThrow(
      /FinancialTransferAllocation_append_only/,
    );
  });

  it('rejects reclassifying immutable paid/free lot provenance', async () => {
    const world = await makeFinancialWorld();
    await expect(
      prisma.pointLot.update({
        where: { id: world.lot.id },
        data: { sourceKind: 'FREE' },
      }),
    ).rejects.toThrow(/PointLot_basis_immutable/);
  });
});
