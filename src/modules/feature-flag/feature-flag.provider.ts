import {
  ErrorCode,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
  StandardResolutionReasons,
} from '@openfeature/server-sdk';
import type { ReadDbClient } from '../../db/db.js';
import type { Clock } from '../../foundation/clock.js';
import { isActive, type Stage } from './feature-flag.core.js';
import * as flagRepo from './feature-flag.repo.js';

/**
 * The DB-backed OpenFeature provider — the crepe feature-flag store adapted to
 * the OpenFeature `Provider` port. This is the ADAPTER: OpenFeature is the
 * vendor-neutral seam, so swapping this for flagd / Unleash / LaunchDarkly later
 * is a provider change with zero call-site edits. It is a CLASS (not gannet's
 * usual factory function) because the SDK's `Provider` is an interface a provider
 * class implements — the sanctioned exception, mirroring the SDK's own
 * `InMemoryProvider`.
 *
 * The activation RULE is not here — it is the pure core predicate `isActive` (a
 * business `if` in the provider would be a leaked decision). The provider only
 * fetches the one live row and supplies `now`. Two independent "off" knobs meet
 * here and both fail safe:
 *   - OpenFeature's `defaultValue` — returned when NO live row exists.
 *   - crepe's safe-default INACTIVE — a row exists but the predicate is false.
 * A missing/invalid stage (`stage === null`) can never activate a flag; it
 * returns the caller's default with reason `ERROR` (surfacing the misconfig to
 * observability). Because every crepe-backed gate's registered default is
 * `false`, that path is also "off" — an unconfigured stage fails every gate
 * closed, exactly as crepe requires.
 *
 * Boolean gates and STRING variants are DB-backed. A gate is `isActive(row)`; a
 * string returns the active row's `value` column (the variant payload). Number
 * and object flags return the caller's default — the crepe model carries no
 * numeric/JSON payload, so those would come from a richer provider (flagd, etc.).
 *
 * `stage` is injected (from `parseStage(process.env.STAGE)` in the composition
 * root), and the DB handle is `ReadDbClient` — the provider only reads. It reads
 * the PRIMARY: a flag gate is a DECISION (whether to allow an operation), and
 * gannet decides on primary state, never a lagging replica.
 *
 * `now` comes from the injected `Clock`, not an ambient `new Date()` — the same
 * discipline the rest of the codebase follows (CONVENTIONS §10): the window
 * evaluation is a time-sensitive decision, so its clock is a seam a test can pin,
 * making "does this flag's window contain now" deterministic.
 */
export class DbFeatureFlagProvider implements Provider {
  readonly runsOn = 'server' as const;
  readonly metadata = { name: 'gannet-db-feature-flags' } as const;

  constructor(
    private readonly db: ReadDbClient,
    private readonly stage: Stage | null,
    private readonly clock: Clock,
  ) {}

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
  ): Promise<ResolutionDetails<boolean>> {
    if (this.stage === null) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PARSE_ERROR,
        errorMessage: 'STAGE is unset or not a known deploy stage',
      };
    }
    const row = await flagRepo.findLiveByName(this.db, flagKey);
    if (row === null) {
      return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT };
    }
    const on = isActive(row, this.stage, this.clock.now());
    return {
      value: on,
      reason: on ? StandardResolutionReasons.TARGETING_MATCH : StandardResolutionReasons.DISABLED,
    };
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
  ): Promise<ResolutionDetails<string>> {
    if (this.stage === null) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PARSE_ERROR,
        errorMessage: 'STAGE is unset or not a known deploy stage',
      };
    }
    const row = await flagRepo.findLiveByName(this.db, flagKey);
    if (row !== null && row.value !== null && isActive(row, this.stage, this.clock.now())) {
      return { value: row.value, reason: StandardResolutionReasons.TARGETING_MATCH };
    }
    return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT };
  }

  resolveNumberEvaluation(_flagKey: string, defaultValue: number): Promise<ResolutionDetails<number>> {
    return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.DEFAULT });
  }

  resolveObjectEvaluation<T extends JsonValue>(
    _flagKey: string,
    defaultValue: T,
  ): Promise<ResolutionDetails<T>> {
    return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.DEFAULT });
  }
}
