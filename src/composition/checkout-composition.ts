import type { Db } from '../db/db.js';
import {
  loadCommissionTypeForCheckout,
} from '../modules/commission-type/commission-type.checkout.js';
import {
  createContractFromPaidOrder,
} from '../modules/contract/contract.checkout.js';
import {
  locateFinancialHolder,
  reserveFundsForCheckout,
} from '../modules/financial-ledger/financial-ledger.checkout.js';
import {
  attachReservationAndMarkOrderPaid,
  loadOrderPaymentForCheckout,
  locateOrderCheckoutLocks,
} from '../modules/order/order.checkout.js';
import {
  confirmSlotForCheckout,
  loadSlotForCheckout,
} from '../modules/slot/slot.checkout.js';
import type { CheckoutPorts } from '../modules/checkout/checkout.port.js';
import { createCheckoutService } from '../modules/checkout/checkout.service.js';

export interface CheckoutCompositionOptions {
  createContract?: ReturnType<CheckoutPorts['bindTransaction']>['contract']['create'];
}

/** PROTOTYPE — the only file that imports checkout and all owner implementations. */
export function createCheckoutComposition(db: Db, options: CheckoutCompositionOptions = {}) {
  const ports: CheckoutPorts = {
    locateOrderLockTargets: (orderPaymentId) => locateOrderCheckoutLocks(db.rw, orderPaymentId),
    locateFinancialHolder: (binding) => locateFinancialHolder(db.rw, binding),
    bindTransaction: (tx) => ({
      order: {
        loadPayment: (orderPaymentId) => loadOrderPaymentForCheckout(tx, orderPaymentId),
        markPaid: (input) => attachReservationAndMarkOrderPaid(tx, input),
      },
      commissionType: { load: (id) => loadCommissionTypeForCheckout(tx, id) },
      finance: {
        locateHolder: (binding) => locateFinancialHolder(tx, binding),
        reserve: (request) => reserveFundsForCheckout(tx, request),
      },
      contract: {
        create: (formation) =>
          options.createContract
            ? options.createContract(formation)
            : createContractFromPaidOrder(tx, formation),
      },
      slot: {
        load: (id) => loadSlotForCheckout(tx, id),
        confirm: (input) => confirmSlotForCheckout(tx, input),
      },
    }),
  };
  return createCheckoutService({ db, ports });
}
