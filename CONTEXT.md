# Domain context

## Financial transaction identity

- **Transaction Flow** is one business lifecycle. A commission Order owns one `COMMISSION` flow from payment through income settlement. A withdrawal owns a separate `WITHDRAWAL` flow because one withdrawal may consume income from several commissions.
- **Reference ID** is the public form of a flow identity, such as `COMMISSION-<flow UUID>` or `WITHDRAWAL-<flow UUID>`. The UUID provides uniqueness; the stored kind provides meaning.
- **Command Run** is an idempotent request to perform one financial operation. Its public id is `CMD-<kind>-<command UUID>`, such as `CMD-PAY-…`. The idempotency key is scoped by principal and command kind.
- **Operation** is the committed financial result of a command. Its public id is `OP-<kind>-<operation UUID>`. A composite foreign key requires its flow and kind to equal the originating command's flow and kind.
- **Transfer Action** moves one Currency between accounts without changing its amount.
- **Swap Action** settles value between two Currencies as one economic result. Commission settlement consumes POINT held for that commission and creates the worker's INCOME at the explicit quote.
- **INCOME** is the worker's internal, withdrawable earnings Currency. Its availability is expressed by the account holding it, rather than by changing the Currency's meaning.
- **Financial Lot** is an amount of one Currency with one origin and a remaining consumable amount. An INCOME lot's origin is the commission settlement that created it.
- **Withdrawal** is a request to reserve available INCOME for external payout. Its allocations preserve the amount taken from each source commission.
- **Idempotency Key** identifies a caller's retry. Repeating the same key returns the same command and operation. A new key for an already paid OrderPayment records a new Command Run that points to the existing operation, so it does not duplicate the transfer.

Command identity, payload, subject, flow, and kind are immutable in PostgreSQL. Its result operation may move from NULL to the operation it originated exactly once; an alias command already pointing at a result cannot originate another operation. Operations, actions, FinancialLot provenance, holder bindings, and withdrawal facts are immutable; reservation state moves only from a funded commission hold to its validated settlement.

The PoC has `COMMISSION` and `WITHDRAWAL` flows. Commission flows may explicitly permit commission commands such as PAY and SETTLE; withdrawal flows permit WITHDRAW. Adding a command kind does not authorize it for any flow—the flow creator chooses the allowed commands.
