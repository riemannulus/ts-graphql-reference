import type { Client, EvaluationContext } from '@openfeature/server-sdk';
import { FeatureDisabledError } from '../foundation/errors.js';
import type { FlagReader, FlagSpec } from './flags.js';

/**
 * Binds a flag registry to an OpenFeature client for ONE request — the `uow.ts`
 * analogue: the I/O shell over the pure machinery (`flags.ts`) and catalog
 * (`flag-registry.ts`). This is the only facade file that touches the SDK, so
 * `flags.ts` / `flag-registry.ts` stay dependency-free.
 *
 * Each accessor reads through the client with the flag's registered default and
 * the request's `EvaluationContext` (the targeting seam — see `context.ts`).
 * Reads are MEMOIZED per reader instance: the first read of a flag caches the
 * in-flight promise, so a flag read twice in one request cannot flip mid-request.
 * That is the reader-level analogue of `uow.snapshot`'s single-consistent-world
 * guarantee — a resolver and the service it calls always see the same value. A
 * fresh reader (hence a fresh memo) is minted per request in the context factory.
 *
 * `assert.<gate>()` throws `FeatureDisabledError` (a `DomainError`, surfaced by
 * Yoga's `maskError` as code `UNAVAILABLE`) when the gate is off.
 *
 * Generic over the spec map so a test can bind a fixture registry; production
 * passes `FLAGS` (see `context.ts`).
 */
export function createFlagReader<T extends Record<string, FlagSpec>>(
  specs: T,
  client: Client,
  context: EvaluationContext = {},
): FlagReader<T> {
  // One memo per reader (hence per request): the first read of a flag caches the
  // in-flight promise; keyed by name, so each key's stored promise has one type.
  const memo = new Map<string, Promise<unknown>>();
  const readGate = (flagKey: string, defaultValue: boolean): Promise<boolean> => {
    let pending = memo.get(flagKey) as Promise<boolean> | undefined;
    if (pending === undefined) {
      pending = client.getBooleanDetails(flagKey, defaultValue, context).then((d) => d.value);
      memo.set(flagKey, pending);
    }
    return pending;
  };
  const readVariant = (flagKey: string, defaultValue: string): Promise<string> => {
    let pending = memo.get(flagKey) as Promise<string> | undefined;
    if (pending === undefined) {
      pending = client.getStringDetails(flagKey, defaultValue, context).then((d) => d.value);
      memo.set(flagKey, pending);
    }
    return pending;
  };

  const reader: Record<string, () => Promise<unknown>> = {};
  const assert: Record<string, () => Promise<void>> = {};
  for (const [flagKey, spec] of Object.entries(specs)) {
    if (spec.kind === 'gate') {
      const { default: defaultValue } = spec;
      reader[flagKey] = () => readGate(flagKey, defaultValue);
      assert[flagKey] = async () => {
        if (!(await readGate(flagKey, defaultValue))) {
          throw new FeatureDisabledError(flagKey);
        }
      };
    } else {
      // variant: read the string, then narrow to a known variant (a backend that
      // returns an out-of-set value falls back to the declared default).
      const { default: defaultVariant, variants } = spec;
      reader[flagKey] = async () => {
        const value = await readVariant(flagKey, defaultVariant);
        return variants.includes(value) ? value : defaultVariant;
      };
    }
  }
  return { ...reader, assert } as unknown as FlagReader<T>;
}
