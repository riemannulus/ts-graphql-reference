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

export function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isDomainError?: unknown }).isDomainError === true
  );
}
