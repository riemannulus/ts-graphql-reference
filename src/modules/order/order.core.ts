import { DomainError } from '../../foundation/errors.js';

export class OrderPaymentNotFoundError extends DomainError {
  constructor(id: number) {
    super(`Order payment ${id} does not exist`, 'ORDER_PAYMENT_NOT_FOUND');
  }
}
