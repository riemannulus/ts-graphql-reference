import type { DbClient, ReadDbClient } from '../../db/db.js';

/** PROTOTYPE — checkout-owned DTOs. Owner modules are adapted to these shapes. */
export interface CheckoutInput {
  orderPaymentId: number;
  actorId: number;
  commandKey: string;
}

export interface OrderPaymentFacts {
  orderId: number;
  orderPaymentId: number;
  buyerId: number;
  commissionTypeId: number;
  slotId: number;
  titleSnapshot: string;
  referenceId: string;
  orderAmount: number;
  paymentAmount: number;
  orderCurrency: string;
  paymentCurrency: string;
  orderState: string;
  paymentState: string;
}

export interface CommissionTypeFacts {
  commissionTypeId: number;
  workerId: number;
  price: number;
}

export interface SlotFacts {
  slotId: number;
  workerId: number;
  state: string;
}

export interface CheckoutFacts extends OrderPaymentFacts {
  commissionWorkerId: number;
  commissionPrice: number;
  slotWorkerId: number;
  slotState: string;
  financialHolderId: number;
}

export interface FinancialRequest {
  referenceId: string;
  bindingNamespace: string;
  bindingKey: string;
  holderId: number;
  currency: 'POINT';
  amount: number;
}

export interface PaymentIntent {
  orderId: number;
  orderPaymentId: number;
  buyerId: number;
  workerId: number;
  commissionTypeId: number;
  slotId: number;
  financialHolderId: number;
  titleSnapshot: string;
  holderBinding: { namespace: 'user'; key: string };
  financialRequest: FinancialRequest;
}

export interface ReservationReceipt extends FinancialRequest {
  reservationId: number;
}

export interface ContractFormation {
  orderId: number;
  buyerId: number;
  workerId: number;
  reservationId: number;
}

export interface CheckoutResult {
  orderId: number;
  orderPaymentId: number;
  contractId: number;
  reservationId: number;
  replayed: boolean;
}

export interface CheckoutPorts {
  order: {
    locateLockTargets(
      db: ReadDbClient,
      orderPaymentId: number,
    ): Promise<{ buyerId: number; slotId: number }>;
    loadPayment(db: ReadDbClient, orderPaymentId: number): Promise<OrderPaymentFacts>;
    markPaid(
      db: DbClient,
      input: { orderId: number; orderPaymentId: number; reservationId: number },
    ): Promise<void>;
  };
  commissionType: {
    load(db: ReadDbClient, commissionTypeId: number): Promise<CommissionTypeFacts>;
  };
  finance: {
    locateHolder(
      db: ReadDbClient,
      binding: { namespace: 'user'; key: string },
    ): Promise<number>;
    reserve(db: DbClient, request: FinancialRequest): Promise<ReservationReceipt>;
  };
  contract: {
    create(db: DbClient, formation: ContractFormation): Promise<{ contractId: number }>;
  };
  slot: {
    load(db: ReadDbClient, slotId: number): Promise<SlotFacts>;
    confirm(db: DbClient, input: { slotId: number; workerId: number }): Promise<void>;
  };
}
