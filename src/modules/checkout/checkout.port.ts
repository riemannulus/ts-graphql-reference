import type { DbClient } from '../../db/db.js';

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
  referenceId: string;
  orderAmount: number;
  paymentAmount: number;
  orderCurrency: string;
  paymentCurrency: string;
  orderState: string;
  paymentState: string;
}

export interface CommissionTypeFacts {
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
  purpose: 'COMMISSION_PAYMENT';
  currency: 'POINT';
  amount: number;
}

export interface PaymentIntent {
  orderId: number;
  orderPaymentId: number;
  buyerId: number;
  workerId: number;
  slotId: number;
  financialRequest: FinancialRequest;
}

export interface ReservationReceipt extends FinancialRequest {
  reservationId: number;
}

export interface ContractFormation {
  orderId: number;
  buyerId: number;
  workerId: number;
}

export interface CheckoutResult {
  orderId: number;
  orderPaymentId: number;
  contractId: number;
  reservationId: number;
  replayed: boolean;
}

export interface CheckoutTransactionPorts {
  order: {
    loadPayment(orderPaymentId: number): Promise<OrderPaymentFacts>;
    markPaid(input: {
      orderId: number;
      orderPaymentId: number;
      reservationId: number;
    }): Promise<void>;
  };
  commissionType: {
    load(commissionTypeId: number): Promise<CommissionTypeFacts>;
  };
  finance: {
    locateHolder(binding: { namespace: 'user'; key: string }): Promise<number>;
    reserve(request: FinancialRequest): Promise<ReservationReceipt>;
  };
  contract: {
    create(formation: ContractFormation): Promise<{ contractId: number }>;
  };
  slot: {
    load(slotId: number): Promise<SlotFacts>;
    confirm(input: { slotId: number; workerId: number }): Promise<void>;
  };
}

/** The composition root retains DB capabilities and binds them per transaction. */
export interface CheckoutPorts {
  locateOrderLockTargets(orderPaymentId: number): Promise<{ buyerId: number; slotId: number }>;
  locateFinancialHolder(binding: { namespace: 'user'; key: string }): Promise<number>;
  bindTransaction(db: DbClient): CheckoutTransactionPorts;
}
