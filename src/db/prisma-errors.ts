/**
 * Structural checks for Prisma's error CODES.
 *
 * Detection reads the `code` property structurally (no `instanceof`, which can
 * fail across module realms in test runners). This is Prisma-error
 * classification — deliberately separate from the `Db` handle (`db.ts`) so the
 * toolkit (`uow.ts`) and repos can translate infrastructure failures into domain
 * outcomes without depending on how the client is constructed. Pure: no imports,
 * no I/O.
 */
function prismaErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** P2002 — a unique constraint was violated. */
export function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2002';
}

/** P2025 — the row a guarded `update` targeted no longer matches. */
export function isRecordNotFound(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2025';
}

/**
 * P2034 — the transaction failed a serialization check (e.g. a REPEATABLE READ
 * transaction touched a row a concurrent transaction changed). Retryable.
 */
export function isSerializationConflict(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2034';
}
