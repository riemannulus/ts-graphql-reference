import { registerLedgerQueries } from './ledger.query.js';
import { registerLedgerTypes } from './ledger.type.js';

/**
 * The ledger module's GraphQL surface, registered as one unit. A composition
 * point, not a barrel: it calls the register functions, it does not re-export
 * the module's core / repo / service — so the file-name lint globs that enforce
 * the layering stay intact.
 *
 * **Queries only, deliberately.** There is no `ledgerPost` mutation, because a
 * movement of value is never a client's decision — it is a domain's. Whichever
 * module owns the reason value is moving (a top-up, an order settling, a gift
 * redeemed) reaches the ledger through `services.ledger.post`, carrying the
 * gates that make that particular movement legitimate: who may pay, whether the
 * seller is verified, whether the window has closed. Exposing the primitives
 * directly would let a caller mint value with a well-formed request, and no
 * amount of authorization bolted on top would put those gates back.
 */
export function registerLedgerModule(): void {
  registerLedgerTypes();
  registerLedgerQueries();
}
