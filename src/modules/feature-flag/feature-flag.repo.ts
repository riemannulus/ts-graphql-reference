import type { FeatureFlag } from '@prisma/client';
import type { DbClient, ReadDbClient } from '../../db/db.js';

/**
 * Feature-flag persistence. The provider's live-row lookup (a read) and the admin
 * write functions live together — the module has no read/write split yet (see the
 * graduation rule: split `*.read.repo.ts` / `*.write.repo.ts` only when it grows).
 * Every function takes the client as its first argument and never chooses it.
 */

/**
 * The one LIVE row for `name`, or null. Single-valued by the partial unique index
 * (`FeatureFlag_name_live_key`), so `findFirst` returns THE live row — a
 * soft-deleted row of the same name is invisible here.
 */
export function findLiveByName(db: ReadDbClient, name: string): Promise<FeatureFlag | null> {
  return db.featureFlag.findFirst({ where: { name, deletedAt: null } });
}

/** The fields an upsert writes (the surrogate `id`, timestamps, and `deletedAt` are managed here). */
export interface FlagWrite {
  name: string;
  description: string | null;
  stage: string | null;
  value: string | null;
  enableAfter: Date | null;
  disableAfter: Date | null;
}

/**
 * Creates a new live flag row. Used both for a brand-new name and to recreate a
 * name after a soft delete — the partial unique index permits the coexistence of
 * one live row and any number of soft-deleted rows of the same name.
 */
export function insert(db: DbClient, data: FlagWrite): Promise<FeatureFlag> {
  return db.featureFlag.create({ data });
}

/** Overwrites the fields of the LIVE row `id` (the caller found it via findLiveByName). */
export function update(db: DbClient, id: number, data: FlagWrite): Promise<FeatureFlag> {
  return db.featureFlag.update({ where: { id }, data });
}

/** Soft-deletes a flag (records `deletedAt`) — the crepe kill; the name is then reusable. */
export function softDelete(db: DbClient, id: number): Promise<FeatureFlag> {
  return db.featureFlag.update({ where: { id }, data: { deletedAt: new Date() } });
}
