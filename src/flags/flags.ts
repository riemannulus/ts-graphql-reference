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
 *
 * Every spec also declares its LIFECYCLE — the code-level half of the flag's
 * life. The DB half already has one (live → soft-deleted → hard-deleted by the
 * `feature-flag:purge-deleted` job); without a code-level counterpart a registry
 * entry and its call sites would outlive the rows forever. `permanent` marks a
 * flag that is allowed to (a kill switch, an ops toggle); `temporary(removeBy)`
 * marks a rollout/experiment flag that must be REMOVED from the registry by a
 * KST calendar date — `expiredFlags` turns that promise into a CI failure (see
 * `flag-hygiene.test.ts`), and deleting the entry makes every call site a
 * compile error, so the compiler drives the code purge the way the job drives
 * the DB purge.
 */

/**
 * A flag's code-level lifecycle. `permanent`: the entry may stay indefinitely
 * (declare WHY in the flag's doc). `temporary`: the entry must be deleted from
 * the registry — call sites included — by the end of the KST calendar day
 * `removeBy` (ISO `YYYY-MM-DD`); past it, the hygiene check fails the build.
 */
export type FlagLifecycle =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'temporary'; readonly removeBy: string };

/** The lifecycle of a flag that is allowed to live in the registry indefinitely. */
export const permanent: FlagLifecycle = { kind: 'permanent' };

/**
 * Is `value` an ISO `YYYY-MM-DD` string naming a real calendar day? Pure and
 * total — plain arithmetic (including the leap-year rule), no Date global (the
 * clock seam stays foundation/clock.ts) and no date library (that seam stays
 * foundation/time.ts).
 */
export function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= daysInMonth;
}

/**
 * The lifecycle of a rollout/experiment flag: remove the registry entry by the
 * KST calendar day `removeBy`. Parse, don't validate — a malformed date throws
 * HERE, at registry-module load (so a typo fails every test run and the boot),
 * never lingering as a deadline that can neither expire nor be compared.
 */
export function temporary(removeBy: string): FlagLifecycle {
  if (!isIsoCalendarDate(removeBy)) {
    throw new Error(`temporary(): removeBy must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(removeBy)}`);
  }
  return { kind: 'temporary', removeBy };
}

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
  readonly lifecycle: FlagLifecycle;
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
  readonly lifecycle: FlagLifecycle;
}

/** Every flag spec kind. */
export type FlagSpec = GateSpec | VariantSpec<string>;

/** Declares an on/off gate with its safe-default, a one-line description, and its
 * lifecycle (`permanent` | `temporary(removeBy)`) — declaring intent is REQUIRED,
 * so "this flag will outlive its purpose" can never happen by omission. */
export const gate = (defaultValue: boolean, doc: string, lifecycle: FlagLifecycle): GateSpec => ({
  kind: 'gate',
  default: defaultValue,
  doc,
  lifecycle,
});

/** Declares a variant flag from a fixed set of names, with its default,
 * description, and lifecycle (required, as for `gate`). */
export const variant = <const V extends string>(
  variants: readonly V[],
  defaultVariant: V,
  doc: string,
  lifecycle: FlagLifecycle,
): VariantSpec<V> => ({ kind: 'variant', variants, default: defaultVariant, doc, lifecycle });

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

/** One overdue registry entry: the flag's name and the deadline it has outlived. */
export interface ExpiredFlag {
  readonly name: string;
  readonly removeBy: string;
}

/**
 * The temporary flags in `specs` whose `removeBy` day has fully passed — the
 * code-level purge predicate, the `purgeCutoff` analogue for the registry.
 * `today` is the KST calendar date as data (the caller computes it via
 * `foundation/time.ts` `kstCalendarDate`; this module reads no clock), and a
 * flag lives THROUGH its `removeBy` day: expired means `today > removeBy`
 * (lexicographic — ISO dates order that way). A malformed `today` throws
 * rather than silently expiring nothing. Registry (declaration) order is kept.
 */
export function expiredFlags(specs: Record<string, FlagSpec>, today: string): ExpiredFlag[] {
  if (!isIsoCalendarDate(today)) {
    throw new Error(`expiredFlags(): today must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(today)}`);
  }
  return Object.entries(specs).flatMap(([name, spec]) =>
    spec.lifecycle.kind === 'temporary' && today > spec.lifecycle.removeBy
      ? [{ name, removeBy: spec.lifecycle.removeBy }]
      : [],
  );
}
