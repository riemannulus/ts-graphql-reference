import { DomainError } from '../../foundation/errors.js';

export const POINT_CHARGE_PAYMENT_NAMESPACE = 'point-charge-payment';
export const POINT_CHARGE_ACCOUNTING_POLICY_VERSION = 'point-charge-v1';

export interface PointChargeInput {
  actorId: number;
  amount: number;
  externalPaymentId: string;
  commandKey: string;
}

export interface PointChargeWorld {
  holderId: number;
  availableAccountId: number;
}

export class PointChargeStateError extends DomainError {
  constructor(message: string) {
    super(message, 'POINT_CHARGE_INVALID');
  }
}

interface PointChargeCommandIdentity {
  flowKind: string;
  kind: string;
  principalId: number;
  idempotencyKey: string;
  subjectNamespace: string;
  subjectKey: string;
}

interface StoredPointChargeIdentity extends PointChargeCommandIdentity {
  flowId: string;
  payloadHash: string;
  operationDbId: string | null;
  operationId: string | null;
  referenceId: string;
  commandId: string;
}

export function planPointChargeCommand(input: PointChargeInput) {
  return {
    flowKind: 'POINT_CHARGE' as const,
    kind: 'CHARGE' as const,
    principalId: input.actorId,
    idempotencyKey: input.commandKey,
    subjectNamespace: POINT_CHARGE_PAYMENT_NAMESPACE,
    subjectKey: input.externalPaymentId,
  } as const;
}

function assertPointChargeIdentity(
  stored: StoredPointChargeIdentity,
  requested: PointChargeCommandIdentity & { payloadHash: string },
): asserts stored is StoredPointChargeIdentity & {
  operationDbId: string;
  operationId: string;
} {
  if (
    stored.flowKind !== requested.flowKind ||
    stored.kind !== requested.kind ||
    stored.principalId !== requested.principalId ||
    stored.payloadHash !== requested.payloadHash ||
    stored.subjectNamespace !== requested.subjectNamespace ||
    stored.subjectKey !== requested.subjectKey
  ) {
    throw new PointChargeStateError('Point charge command identity mismatch');
  }
  if (!stored.operationDbId || !stored.operationId) {
    throw new PointChargeStateError('Point charge command has no completed operation');
  }
}

export function planPointChargeStart(
  command: StoredPointChargeIdentity | null,
  payment: StoredPointChargeIdentity | null,
  requested: PointChargeCommandIdentity & { payloadHash: string },
) {
  const stored = command ?? payment;
  if (!stored) return { kind: 'PROCEED' as const };

  assertPointChargeIdentity(stored, requested);
  return { kind: 'REPLAY' as const, identity: stored };
}

export function planPointCharge(world: PointChargeWorld, input: PointChargeInput) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new PointChargeStateError('Point charge amount must be a positive integer');
  }
  if (!input.externalPaymentId) {
    throw new PointChargeStateError('External payment id is required');
  }
  if (!input.commandKey) {
    throw new PointChargeStateError('Command key is required');
  }

  return {
    flowRequest: { kind: 'POINT_CHARGE' as const, allowedCommands: ['CHARGE'] as const },
    commandRequest: planPointChargeCommand(input),
    operationRequest: { kind: 'CHARGE' as const },
    lotRequest: {
      holderId: world.holderId,
      accountId: world.availableAccountId,
      currency: 'POINT' as const,
      sourceKind: 'PAID' as const,
      issuanceReason: 'PURCHASE' as const,
      accountingCategory: 'CUSTOMER_ADVANCE' as const,
      accountingPolicyVersion: POINT_CHARGE_ACCOUNTING_POLICY_VERSION,
      amount: input.amount,
    },
  };
}

export type PointChargePlan = ReturnType<typeof planPointCharge>;

export interface PointChargeResult {
  lotId: number;
  amount: number;
  referenceId: string;
  commandId: string;
  operationId: string;
  replayed: boolean;
}

export interface CommissionPointFundingAllocation {
  lotId: number;
  amount: number;
  sourceFlowId: string | null;
  sourceFlowKind: string | null;
  sourceOperationId: string | null;
  sourceOperationKind: string | null;
  issuanceReason: string | null;
  accountingCategory: string | null;
  accountingPolicyVersion: string | null;
}

export interface PointChargeFundingSource {
  lotId: number;
  operationId: string;
  flowId: string;
  amount: number;
  issuanceReason: string;
  accountingCategory: string;
  accountingPolicyVersion: string;
}

export function identifyPointChargeFundingSources(
  allocations: readonly CommissionPointFundingAllocation[],
): PointChargeFundingSource[] {
  return allocations.map((allocation) => {
    if (
      !allocation.sourceFlowId ||
      allocation.sourceFlowKind !== 'POINT_CHARGE' ||
      !allocation.sourceOperationId ||
      allocation.sourceOperationKind !== 'CHARGE' ||
      !allocation.issuanceReason ||
      !allocation.accountingCategory ||
      !allocation.accountingPolicyVersion
    ) {
      throw new PointChargeStateError(
        `Commission allocation from lot ${allocation.lotId} has no point-charge source`,
      );
    }
    return {
      lotId: allocation.lotId,
      operationId: allocation.sourceOperationId,
      flowId: allocation.sourceFlowId,
      amount: allocation.amount,
      issuanceReason: allocation.issuanceReason,
      accountingCategory: allocation.accountingCategory,
      accountingPolicyVersion: allocation.accountingPolicyVersion,
    };
  });
}
