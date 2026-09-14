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
  createContract?: CheckoutPorts['contract']['create'];
}

/** PROTOTYPE — the only file that imports checkout and all owner implementations. */
export function createCheckoutComposition(db: Db, options: CheckoutCompositionOptions = {}) {
  const ports: CheckoutPorts = {
    order: {
      locateLockTargets: locateOrderCheckoutLocks,
      loadPayment: loadOrderPaymentForCheckout,
      markPaid: attachReservationAndMarkOrderPaid,
    },
    commissionType: { load: loadCommissionTypeForCheckout },
    finance: { locateHolder: locateFinancialHolder, reserve: reserveFundsForCheckout },
    contract: { create: options.createContract ?? createContractFromPaidOrder },
    slot: { load: loadSlotForCheckout, confirm: confirmSlotForCheckout },
  };
  return createCheckoutService({ db, ports });
}
