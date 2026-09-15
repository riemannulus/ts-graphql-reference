import { ConcurrentUpdateError, DomainError } from '../../foundation/errors.js';

export const COMMISSION_ORDER_PAYMENT_NAMESPACE = 'commission-order-payment';
export const COMMISSION_COMMAND_KINDS = [
  'PAY',
  'EXTRA_PAY',
  'SETTLE',
  'REFUND',
  'CANCEL',
] as const;

export interface CommissionCheckoutInput {
  orderPaymentId: number;
  actorId: number;
  commandKey: string;
}

export interface CommissionCheckoutWorld {
  order: {
    id: number;
    buyerId: number;
    flowId: string;
    amount: number;
    currency: string;
    state: string;
  };
  payment: {
    id: number;
    flowId: string;
    amount: number;
    currency: string;
    state: string;
  };
  terms: { workerId: number; price: number };
  slot: { id: number; workerId: number; state: string };
  funding: { holderId: number };
}

interface CommissionPaymentReservationRequest {
  flowId: string;
  bindingNamespace: string;
  bindingKey: string;
  holderId: number;
  purpose: 'COMMISSION_PAYMENT';
  currency: 'POINT';
  amount: number;
}

export interface CommissionCheckoutPlan {
  commandRequest: {
    flowId: string;
    flowKind: 'COMMISSION';
    kind: 'PAY';
    principalId: number;
    idempotencyKey: string;
    subjectNamespace: typeof COMMISSION_ORDER_PAYMENT_NAMESPACE;
    subjectKey: string;
  };
  operationRequest: {
    kind: 'PAY';
    actionKind: 'TRANSFER';
  };
  financialRequest: CommissionPaymentReservationRequest;
  contract: {
    orderId: number;
    flowId: string;
    buyerId: number;
    workerId: number;
  };
  paidOrder: {
    orderId: number;
    orderPaymentId: number;
    flowId: string;
  };
  occupiedSlot: {
    slotId: number;
    workerId: number;
  };
}

export interface CommissionCheckoutResult {
  orderId: number;
  orderPaymentId: number;
  contractId: number;
  reservationId: number;
  referenceId: string;
  commandId: string;
  operationId: string;
  replayed: boolean;
}

type CommissionCheckoutEconomicResult = Omit<CommissionCheckoutResult, 'replayed'>;

interface ExistingCommissionCheckout {
  payloadHash: string;
  buyerId: number;
  result: CommissionCheckoutEconomicResult;
}

type CommissionCheckoutStartPlan =
  | { kind: 'PROCEED' }
  | { kind: 'REPLAY'; result: CommissionCheckoutEconomicResult; saveAlias: boolean };

export class CommissionCheckoutActorError extends DomainError {
  constructor() {
    super(
      'Only the Order buyer can complete commission checkout',
      'COMMISSION_CHECKOUT_ACTOR_MISMATCH',
    );
  }
}

export class CommissionCheckoutStateError extends DomainError {
  constructor(message: string) {
    super(message, 'ORDER_NOT_PAYABLE');
  }
}

export class CommissionCheckoutIdempotencyError extends DomainError {
  constructor() {
    super(
      'Commission checkout command key was already used for a different payload',
      'IDEMPOTENCY_MISMATCH',
    );
  }
}

interface CommissionCheckoutLockTargets {
  buyerId: number;
  slotId: number;
  financialHolderId: number;
}

export function assertLockedCommissionCheckoutTargets(
  locked: CommissionCheckoutLockTargets,
  actual: CommissionCheckoutLockTargets,
): void {
  if (
    locked.buyerId !== actual.buyerId ||
    locked.slotId !== actual.slotId ||
    locked.financialHolderId !== actual.financialHolderId
  ) {
    throw new ConcurrentUpdateError('commission checkout lock targets');
  }
}

function assertCommissionCheckoutActor(buyerId: number, actorId: number): void {
  if (buyerId !== actorId) throw new CommissionCheckoutActorError();
}

export function planCommissionCheckoutCommand(input: CommissionCheckoutInput) {
  return {
    flowKind: 'COMMISSION' as const,
    kind: 'PAY' as const,
    principalId: input.actorId,
    idempotencyKey: input.commandKey,
    subjectNamespace: COMMISSION_ORDER_PAYMENT_NAMESPACE,
    subjectKey: String(input.orderPaymentId),
  } as const;
}

export function assertCommissionCheckoutReplayIdentity(
  stored: {
    flowKind: string;
    kind: string;
    payloadHash: string;
    subjectNamespace: string;
    subjectKey: string;
  },
  requested: {
    flowKind: string;
    kind: string;
    payloadHash: string;
    subjectNamespace: string;
    subjectKey: string;
  },
): void {
  if (
    stored.flowKind !== requested.flowKind ||
    stored.kind !== requested.kind ||
    stored.payloadHash !== requested.payloadHash ||
    stored.subjectNamespace !== requested.subjectNamespace ||
    stored.subjectKey !== requested.subjectKey
  ) {
    throw new CommissionCheckoutIdempotencyError();
  }
}

export function planCommissionCheckoutStart(
  command: ExistingCommissionCheckout | null,
  payment: ExistingCommissionCheckout | null,
  requestedHash: string,
  actorId: number,
): CommissionCheckoutStartPlan {
  if (command) {
    if (command.payloadHash !== requestedHash) throw new CommissionCheckoutIdempotencyError();
    return { kind: 'REPLAY', result: command.result, saveAlias: false };
  }
  if (payment) {
    assertCommissionCheckoutActor(payment.buyerId, actorId);
    return { kind: 'REPLAY', result: payment.result, saveAlias: true };
  }
  return { kind: 'PROCEED' };
}

export function planCommissionCheckout(
  world: CommissionCheckoutWorld,
  input: CommissionCheckoutInput,
): CommissionCheckoutPlan {
  const { order, payment, terms, slot, funding } = world;

  if (payment.id !== input.orderPaymentId) {
    throw new CommissionCheckoutStateError('Order payment identity changed');
  }
  assertCommissionCheckoutActor(order.buyerId, input.actorId);
  if (order.state !== 'REQUESTED' || payment.state !== 'PENDING') {
    throw new CommissionCheckoutStateError('Order and payment must both be pending');
  }
  if (slot.state !== 'AVAILABLE') {
    throw new CommissionCheckoutStateError('Commission slot is not available');
  }
  if (terms.workerId !== slot.workerId) {
    throw new CommissionCheckoutStateError('Commission slot belongs to a different worker');
  }
  if (order.flowId !== payment.flowId) {
    throw new CommissionCheckoutStateError('Order and payment must belong to the same flow');
  }
  if (
    order.currency !== 'POINT' ||
    payment.currency !== 'POINT' ||
    order.amount !== payment.amount ||
    order.amount !== terms.price
  ) {
    throw new CommissionCheckoutStateError('Order, payment, and commission price must match');
  }

  return {
    commandRequest: {
      flowId: payment.flowId,
      ...planCommissionCheckoutCommand(input),
    },
    operationRequest: { kind: 'PAY', actionKind: 'TRANSFER' },
    financialRequest: {
      flowId: payment.flowId,
      bindingNamespace: COMMISSION_ORDER_PAYMENT_NAMESPACE,
      bindingKey: String(payment.id),
      holderId: funding.holderId,
      purpose: 'COMMISSION_PAYMENT',
      currency: 'POINT',
      amount: payment.amount,
    },
    contract: {
      orderId: order.id,
      flowId: payment.flowId,
      buyerId: order.buyerId,
      workerId: terms.workerId,
    },
    paidOrder: {
      orderId: order.id,
      orderPaymentId: payment.id,
      flowId: payment.flowId,
    },
    occupiedSlot: {
      slotId: slot.id,
      workerId: terms.workerId,
    },
  };
}
