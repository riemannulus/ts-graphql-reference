# ADR 0001: Derive typed financial identifiers from persisted kinds

## Status

Accepted for the commission checkout PoC.

## Context

Short examples such as `TX-COMMISSION-01`, `CMD-PAY-01`, and `OP-PAY-01` explain the hierarchy but are unsafe as stored identifiers: counters can collide across writers, and a free-form prefix can disagree with the row's actual kind. The earlier PoC stored only an arbitrary OrderPayment reference and an idempotency key, so the intended Flow → Command → Operation → Action spine was absent.

## Decision

Persist opaque UUID primary keys and enum kind columns. Derive public identifiers at the boundary:

- `COMMISSION-<flow UUID>`
- `CMD-PAY-<command UUID>`
- `OP-PAY-<operation UUID>`

An Order owns the flow. OrderPayment, Contract, product-finance link, reservation, transfer, command, operation, and transfer action all carry the same `flowId`; composite foreign keys reject cross-flow links. A command also stores the flow kind, and a composite foreign key requires it to match `TransactionFlow(id, kind)`. An operation carries the same `flowId` and command kind, and another composite foreign key requires both values to match its originating command. `FinancialTransferAction` is a structural subtype, so a transfer cannot point at a future SWAP or BURN action.

Every flow instance owns `FlowCommandPolicy` rows. `FinancialCommandRun(flowId, kind)` has a composite foreign key to that allow-list, so broadening an enum alone cannot enable a command. A new flow creator must explicitly write its allowed command kinds.

This unmerged PoC migration is fresh-database only and deliberately does not backfill existing checkout rows. Legacy physical `referenceId` columns remain nullable only because the preceding PoC migration created them. New code never writes or reads them as public identity. A production adoption needs a separately reviewed backfill and cutover plan.

## Consequences

Prefixes become trustworthy projections of typed data, while UUIDs remove coordination and collision concerns. Queries can follow one commission across payment and later operations by `flowId`. Same-key retries return one command; a different key may create an alias command for the same operation without repeating the economic effect.

The public strings are longer than the illustrative `-01` aliases. User interfaces may show a shortened suffix for readability, but APIs, logs, and reconciliation exports use the full derived identifier.
