# What

<!-- One paragraph: the change, and the invariant/behavior it adds or fixes. -->

## Module boundary (CONVENTIONS §11)

<!-- Exactly one box — the four-question procedure, first yes wins. -->

- [ ] **Q1 extend** — reads/writes only rows an existing module owns (layer per the graduation rule, §1)
- [ ] **Q2 new owner module** — a new noun with its own lifecycle/invariants; born a leaf, no allowlist edit
- [ ] **Q3 new composite module** — one use-case/transaction composing several owners; the new module takes the edges
- [ ] **Q4 new edge on an existing module** — a use-case this module owns now reaches rows another owner keeps

### Edge audit (required for Q3/Q4 — delete otherwise)

**Coupling ladder rung and why the rungs below don't fit:**
<!-- 0 declared read composition · 1 data as parameter · 2 injected service (type-only) · 3 value import of repo writes -->

- [ ] `.dependency-cruiser.mjs`: module added to the default rule's `pathNot` exemption + its own `X-reaches-Y-only` rule (+ `X-to-Y-is-type-only` for a rung-2 edge)
- [ ] `src/modules/README.md`: edge table row added (edge, why, kind) and the table is still a DAG
- [ ] `pnpm graph:modules` regenerated both SVGs
- [ ] Writes reached across the edge take core-minted types only — branded values or plans (§4); no invariant-guarding service write is exposed
- [ ] Decisions stay in the owning modules' cores; the composing service opens ONE transaction (§5)

## Checks

- [ ] `pnpm typecheck && pnpm lint && pnpm check:graph && pnpm test`
- [ ] SDL snapshot updated if the schema surface changed
