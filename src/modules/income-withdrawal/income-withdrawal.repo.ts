import type { DbClient, ReadDbClient } from '../../db/db.js';

export function createWithdrawal(
  db: DbClient,
  input: {
    flowId: string;
    flowKind: 'WITHDRAWAL';
    operationId: string;
    operationKind: 'WITHDRAW';
    transferActionId: string;
    reservationId: number;
  },
) {
  return db.financialWithdrawal.create({
    data: input,
    select: { id: true, flowId: true, reservationId: true },
  });
}

export async function loadWithdrawalResult(db: ReadDbClient, flowId: string) {
  const withdrawal = await db.financialWithdrawal.findUniqueOrThrow({
    where: { flowId },
    select: {
      id: true,
      reservationId: true,
    },
  });
  return {
    withdrawalId: withdrawal.id,
    reservationId: withdrawal.reservationId,
  };
}

export async function assertWithdrawalShape(db: DbClient) {
  await db.$executeRawUnsafe(
    'SET CONSTRAINTS "FinancialWithdrawal_shape_check", "FinancialWithdrawal_totality_check", "FinancialCommand_effect_completeness_check", "FinancialTransfer_command_completion_check" IMMEDIATE',
  );
}
