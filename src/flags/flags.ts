/**
 * Feature-flag reader MACHINERY — the pure registry builder and the reader TYPE.
 * The `src/db/locks.ts` analogue: WHAT flags exist lives in `flag-registry.ts`
 * (the one file that grows); HOW a reader binds to an OpenFeature client lives in
 * `flag-reader.ts` (the `uow.ts`-style I/O shell). This module imports NOTHING —
 * not even the OpenFeature SDK — so the flag catalog stays as pure and
 * dependency-free as the lock registry (lint-enforced).
 *
 * A flag SPEC is the declaration of one flag: its kind and its default — the
 * value a caller sees when no live rule backs it (for a crepe-backed gate, the
 * safe-default INACTIVE). `defineFlags` is an identity-with-inference helper that
 * pins the literal spec map so `FlagReader` can derive one typed accessor per
 * flag: a typo in a flag name becomes a compile error, and each default lives in
 * exactly one place.
 *
 * Two spec kinds cover the reference's flag-use modes:
 *   - `gate` — a boolean. Read it with `assert` for a KILL/ROLLOUT gate (mode 2),
 *     or read its value and pass it into a core as DATA for a RULE CHANGE (mode 1).
 *   - `variant` — a value from a fixed set, for an IMPLEMENTATION SWAP (mode 3):
 *     the core selects behaviour with an exhaustive `Record<Variant, Impl>`, never
 *     an if-chain, so a new variant that lacks an implementation is a compile error.
 * A new kind is a spec type here plus one accessor branch in `flag-reader.ts`; the
 * registry and every call site are untouched.
 */

/**
 * A boolean on/off gate — an enablement or kill switch, or a rule toggle read as
 * data. `default` is the value a caller sees when no live rule backs the flag; for
 * the crepe DB provider that is the safe-default (`false` = INACTIVE): absent /
 * out-of-window / wrong-stage / soft-deleted all read as `default`.
 */
export interface GateSpec {
  readonly kind: 'gate';
  readonly default: boolean;
  readonly doc: string;
}

/**
 * A choice from a fixed set of string variants — for selecting one implementation
 * of many. `default` is the variant seen when no live rule backs the flag (and the
 * fallback when a backend returns a value outside `variants`).
 */
export interface VariantSpec<V extends string> {
  readonly kind: 'variant';
  readonly variants: readonly V[];
  readonly default: V;
  readonly doc: string;
}

/** Every flag spec kind. */
export type FlagSpec = GateSpec | VariantSpec<string>;

/** Declares an on/off gate with its safe-default and a one-line description. */
export const gate = (defaultValue: boolean, doc: string): GateSpec => ({
  kind: 'gate',
  default: defaultValue,
  doc,
});

/** Declares a variant flag from a fixed set of names, with its default and description. */
export const variant = <const V extends string>(
  variants: readonly V[],
  defaultVariant: V,
  doc: string,
): VariantSpec<V> => ({ kind: 'variant', variants, default: defaultVariant, doc });

/**
 * Pins a flag-registry literal so its keys and defaults are single-sourced and a
 * reader can derive typed accessors from it. Identity at runtime (the value is
 * the object passed in); `const T` captures the exact literal for the type level.
 */
export const defineFlags = <const T extends Record<string, FlagSpec>>(specs: T): T => specs;

/** The accessor one spec contributes to the reader: a gate reads a boolean, a variant reads its narrowed union. */
type Accessor<S extends FlagSpec> = S extends GateSpec
  ? () => Promise<boolean>
  : S extends VariantSpec<infer V>
    ? () => Promise<V>
    : never;

/** The keys whose spec is a gate — only gates get an `assert` member. */
type GateKeys<T extends Record<string, FlagSpec>> = {
  [K in keyof T]: T[K] extends GateSpec ? K : never;
}[keyof T];

/**
 * The typed reader derived from a registry: one accessor per flag, plus an
 * `assert` sub-namespace (gate keys only) whose members throw
 * `FeatureDisabledError` when the gate is off — the flags analogue of
 * `assertTransition = canTransition + throw`. Bound to a client per request; see
 * `flag-reader.ts`.
 */
export type FlagReader<T extends Record<string, FlagSpec>> = {
  readonly [K in keyof T]: Accessor<T[K]>;
} & {
  readonly assert: { readonly [K in GateKeys<T>]: () => Promise<void> };
};
