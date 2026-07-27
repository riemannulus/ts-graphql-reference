/**
 * Base class for *expected* domain/business-rule errors (e.g. an illegal state
 * transition, a uniqueness violation). These are safe to show to clients.
 *
 * Service code throws these without importing anything GraphQL-specific; the
 * GraphQL layer (app.ts) maps them to client-visible errors via Yoga's
 * `maskError`. Anything that is NOT a DomainError is treated as an unexpected
 * internal error and masked.
 */
export class DomainError extends Error {
  /**
   * Structural brand. Detection uses this property (see `isDomainError`) rather
   * than `instanceof`, so it survives module duplication — e.g. test runners
   * that load a module in more than one realm.
   */
  readonly isDomainError = true;

  constructor(
    message: string,
    readonly code: string = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A write's optimistic-concurrency guard missed: the state a decision was made
 * against changed before the execution landed (another request won the race).
 * Expected under contention, safe to retry — hence a DomainError.
 */
export class ConcurrentUpdateError extends DomainError {
  constructor(what: string) {
    super(`Concurrent update on ${what}; retry the operation`, 'CONFLICT');
  }
}

/**
 * A feature-gated operation was invoked while its flag is off. Expected and
 * client-safe (the caller may simply not have the feature enabled), so a
 * DomainError — the shell maps it to a client-visible `UNAVAILABLE`. Thrown by
 * `ctx.flags.assert.<gate>()` (see src/flags/), the flags analogue of
 * `assertTransition`.
 */
export class FeatureDisabledError extends DomainError {
  constructor(readonly flag: string) {
    super(`Feature '${flag}' is not enabled`, 'UNAVAILABLE');
  }
}

/**
 * An operation that requires an authenticated principal was reached without one.
 * Expected and client-safe (an anonymous caller simply has not logged in), so a
 * DomainError — the shell maps it to a client-visible `UNAUTHENTICATED`. Thrown
 * by `requirePrincipal(ctx)` (see src/graphql/context.ts), the principal
 * analogue of `writer(ctx)`'s mutation-only guard.
 *
 * Deliberately carries NO parameter property and interpolates nothing: unlike
 * `FeatureDisabledError`'s flag name, the only value in scope here is the
 * credential itself. A DomainError's message is client-visible AND — per the
 * data-egress caveat in app.ts — recorded pre-mask on the OTel span, so a token
 * must never reach it.
 */
export class UnauthenticatedError extends DomainError {
  constructor() {
    super('Authentication is required for this operation', 'UNAUTHENTICATED');
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isDomainError?: unknown }).isDomainError === true
  );
}
