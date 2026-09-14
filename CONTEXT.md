# Domain context

## Financial transaction identity

- **Transaction Flow** is one business lifecycle. In this PoC a commission Order owns one `COMMISSION` flow before payment, and payment, later settlement, and refund operations keep that flow id.
- **Reference ID** is the public form of a flow identity: `COMMISSION-<flow UUID>`. The UUID provides uniqueness; the stored enum provides meaning. The string is derived and is never an independently writable database fact.
- **Command Run** is an idempotent request to perform one financial operation. Its public id is `CMD-<kind>-<command UUID>`, such as `CMD-PAY-…`. The idempotency key is scoped by principal and command kind.
- **Operation** is the committed financial result of a command. Its public id is `OP-<kind>-<operation UUID>`. A composite foreign key requires its flow and kind to equal the originating command's flow and kind.
- **Transfer Action** is the structurally typed auditable effect inside the current `PAY` operation. It owns the AVAILABLE-to-ESCROW transfer. Future SWAP, ISSUANCE, BURN, or REVERSAL effects use separate subtype tables.
- **Idempotency Key** identifies a caller's retry. Repeating the same key returns the same command and operation. A new key for an already paid OrderPayment records a new Command Run that points to the existing operation, so it does not duplicate the transfer.

Command identity, payload, subject, flow, and kind are immutable in PostgreSQL. Its result operation may move from NULL to the operation it originated exactly once; an alias command already pointing at a result cannot originate another operation. Operations and transfer actions reject every UPDATE and DELETE, preserving the replay and audit history even for writes that bypass the application.

The PoC enum contains only `COMMISSION` flows and commission command kinds (`PAY`, `EXTRA_PAY`, `SETTLE`, `REFUND`, `CANCEL`). Each flow has `FlowCommandPolicy` rows, and a command must match one of them by composite foreign key. Adding an enum value does not authorize it; the flow creator must choose the allowed commands.
