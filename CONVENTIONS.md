# Coding Conventions

How this codebase is organized so that **invariants are first-class** and the
code is **property-based-testing (PBT) friendly**.

## 1. Functional core, imperative shell

Split every module into a **pure core** that holds the rules, and a thin
**shell** that does I/O and delegates decisions to the core.

| Layer            | Files                              | May import                                  | Tested with                |
| ---------------- | ---------------------------------- | ------------------------------------------- | -------------------------- |
| Core (pure)      | `*.state.ts`, `*.value.ts`         | types + other pure modules, `errors.ts`     | unit + **property** tests  |
| Shell (effects)  | `*.service.ts`, `*.schema.ts`, `app.ts` | the core, Prisma, Fastify, Yoga        | integration + **model**-based PBT |

The core never imports Prisma/Fastify/GraphQL. This is what makes it trivially
testable: pure, deterministic, no setup.

## 2. Invariants as code

- **Total functions over partial ones.** A core function must be defined for
  every value of its input type, so a property test can throw arbitrary inputs
  at it. (`canTransition` is defined for every status pair.)
- **Name the rule, use it everywhere.** Encode each rule as a named predicate
  (`canTransition`, `isEmail`) and make higher-level functions defer to it, so
  there is a single source of truth. `assertTransition` is just
  `canTransition` + throw.
- **Expected violations are `DomainError`s** (`src/errors.ts`). The shell maps
  them to client-visible errors; anything else is an unexpected bug and is
  masked. Detection is structural (a brand), not `instanceof`, so it survives
  module duplication in test runners.

## 3. Value objects — parse, don't validate

Push validation to the boundary and encode the result in the type.

```ts
// user.value.ts — the ONLY way to get an Email is to parse one
export type Email = string & { readonly [brand]: 'Email' };
export function parseEmail(raw: string): Email { /* normalize + validate or throw */ }
```

```ts
// user.service.ts — parse once, at the edge
const email = parseEmail(input.email); // invalid input never reaches the DB
```

Downstream code receives an `Email`, not a `string`, so it never re-checks the
invariant. Construction is the validation.

## 4. Property-based testing

Tests assert **laws**, not examples. Tooling: [`@fast-check/vitest`](https://github.com/dubzzz/fast-check)
(`test.prop`). Test files: `*.prop.test.ts` under `src/tests/properties/`.

Generators (arbitraries) live in `src/testing/arbitraries/` and are reused
across tests — generate both valid and invalid inputs.

Laws worth reaching for:

| Law            | Example                                                              |
| -------------- | ------------------------------------------------------------------- |
| Totality       | `assertTransition` only ever throws `InvalidStatusTransitionError`  |
| Idempotence    | `parseEmail(parseEmail(x)) === parseEmail(x)`                       |
| Agreement      | `assertTransition` throws ⇔ `!canTransition` (single source of truth) |
| Terminal state | `∀ to: !canTransition('DEACTIVATED', to)`                          |
| Round-trip     | `decode(encode(x)) === x`                                           |

### Stateful shells → model-based PBT

For a shell with state (e.g. user status in the DB), use `fc.commands` +
`fc.asyncModelRun`: replay a random sequence of operations against both a tiny
in-memory **model** (the spec) and the **real** service, asserting they never
diverge. See `src/tests/properties/user.service.model.test.ts`. The model *is*
the invariant specification.

## 5. Naming & layout

```
src/
  modules/<name>/
    <name>.state.ts     # pure: state machine / invariants
    <name>.value.ts     # pure: value objects (smart constructors)
    <name>.service.ts   # shell: business logic, deps injected via constructor
    <name>.schema.ts    # shell: Pothos types/queries/mutations  (or schemas/ split)
  testing/arbitraries/  # shared fast-check generators (arbXxx)
  tests/
    *.test.ts           # unit / integration
    properties/*.prop.test.ts   # property-based laws
```

## 6. Checklist for a new module

1. Model the data in `prisma/schema.prisma`; `migrate` + `generate`.
2. Put the rules in a pure `*.state.ts` / `*.value.ts` — total functions, named
   predicates, `DomainError`s for violations.
3. Write the shell (`*.service.ts`) with Prisma injected; parse inputs at the
   boundary. Register it in `createServices()` (context.ts).
4. Expose it with Pothos (`*.schema.ts`) and import it in `src/schema.ts`.
5. Add arbitraries in `src/testing/arbitraries/` and property tests asserting
   the module's laws; add a model-based test if it is stateful.
