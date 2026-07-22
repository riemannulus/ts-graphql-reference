import { DomainError } from '../../foundation/errors.js';

/**
 * Feature-flag domain — the pure core (the crepe model).
 *
 * The activation rule — "is this flag on, here, now" — lives here as a TOTAL
 * predicate (`isActive`) so the OpenFeature provider (feature-flag.provider.ts)
 * only fetches the row and supplies `now`: a business `if` in the provider would
 * be a leaked decision. The same predicate is the single source of truth the
 * repo's active-list WHERE mirrors, and it is property-tested with no database.
 *
 * `stage` is a parsed value set (parse, don't validate), also backed by a DB
 * CHECK constraint — so an unknown stage can neither drive an evaluation nor be
 * persisted.
 */

export const STAGES = ['LOCAL', 'DEV', 'QA', 'STG', 'PROD'] as const;
export type Stage = (typeof STAGES)[number];

/** Total predicate: is `value` one of the known deploy stages? */
export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * Parse, don't validate: a raw stage string (the `STAGE` env var, a DB column)
 * becomes a `Stage` only here. Unknown / null / undefined → `null`, which can
 * never activate a flag — matching crepe's safe-default-off for a missing or
 * misconfigured stage.
 */
export function parseStage(value: string | null | undefined): Stage | null {
  return typeof value === 'string' && isStage(value) ? value : null;
}

/**
 * The activation-relevant columns of a flag row — narrow and structural, so a
 * Prisma `FeatureFlag` satisfies it directly and the core stays Prisma-free.
 */
export interface FlagRow {
  stage: string | null;
  enableAfter: Date | null;
  disableAfter: Date | null;
  deletedAt: Date | null;
}

/**
 * The crepe activation predicate — the single source of truth for "is this flag
 * on", identical to the SQL WHERE in the repo's active list and to crepe's
 * `getActiveFeatureFlag`. A flag is ACTIVE iff it is not soft-deleted, its stage
 * is the deploy stage, its enable time has passed, and its disable time (if set)
 * has not. Total: defined for every input, never throws.
 */
export function isActive(row: FlagRow, stage: Stage, now: Date): boolean {
  return (
    row.deletedAt === null &&
    parseStage(row.stage) === stage &&
    row.enableAfter !== null &&
    row.enableAfter.getTime() <= now.getTime() &&
    (row.disableAfter === null || row.disableAfter.getTime() >= now.getTime())
  );
}

/** An admin gave a stage outside the known value set. */
export class UnknownFlagStageError extends DomainError {
  constructor(readonly value: string) {
    super(`Unknown feature-flag stage: ${JSON.stringify(value)}`, 'UNKNOWN_FLAG_STAGE');
  }
}

/** An admin tried to set a window that ends before it starts. */
export class InvalidFlagWindowError extends DomainError {
  constructor() {
    super('disableAfter must be at or after enableAfter', 'INVALID_FLAG_WINDOW');
  }
}

/** What an admin upsert must write — normalized and validated, ready for the repo. */
export interface FlagUpsert {
  name: string;
  description: string | null;
  stage: string | null;
  /** The variant payload for a non-boolean flag; null for a plain gate. */
  value: string | null;
  enableAfter: Date | null;
  disableAfter: Date | null;
}

/**
 * Decides an admin flag upsert: validates the stage value set and the window
 * ordering, returning the write or throwing a `DomainError`. The only decision
 * in the module's admin path — kept out of the service and repo. Total: returns
 * the write or throws `UnknownFlagStageError` | `InvalidFlagWindowError`.
 */
export function planFlagUpsert(input: FlagUpsert): FlagUpsert {
  if (input.stage !== null && parseStage(input.stage) === null) {
    throw new UnknownFlagStageError(input.stage);
  }
  if (
    input.enableAfter !== null &&
    input.disableAfter !== null &&
    input.disableAfter.getTime() < input.enableAfter.getTime()
  ) {
    throw new InvalidFlagWindowError();
  }
  return input;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a soft-deleted flag is kept before the cleanup job hard-deletes it.
 * The retention window is a domain POLICY, so it lives here (single source of
 * truth), not as a literal in the job or the repo — the same reason the
 * activation rule is `isActive` and not a WHERE the provider assembles inline.
 */
export const PURGE_RETENTION_DAYS = 30;

/**
 * The cutoff instant for a purge run: a row soft-deleted at or before this is
 * old enough to hard-delete. Pure and total — the job supplies `now` (the shell
 * owns the clock), and the repo turns this into a `deletedAt <= cutoff` bound.
 * Isolating the arithmetic here keeps the retention policy property-testable
 * (monotonic in `now`, exactly `retentionDays` behind it) with no database.
 */
export function purgeCutoff(now: Date, retentionDays: number = PURGE_RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}
