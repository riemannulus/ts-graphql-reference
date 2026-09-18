# Point charge provenance PoC

This module is an internal use-case with no GraphQL or HTTP delivery. Its input
contains a supplied external-payment identity; the PoC does not verify that
payment. A future public entrypoint must authenticate the principal and bind a
verified provider result before calling `charge()`.

One successful call records `POINT_CHARGE-<flow UUID>` →
`CMD-CHARGE-<command UUID>` → `OP-CHARGE-<operation UUID>` → one paid POINT
lot. The lot stores its issuance reason, accounting category, policy version,
flow, and operation as immutable basis. Commission payment allocations keep the
lot ID, so `traceCommissionFunding()` can return the exact lot, CHARGE operation,
POINT_CHARGE flow, and allocated amount without inferring them from timestamps.

`CHARGE` is exclusive to the POINT_CHARGE family. The flow itself remains
policy-extensible: later `REFUND` or `CANCEL` commands can be added through
`FlowCommandPolicy` with their own typed effects and invariants.
