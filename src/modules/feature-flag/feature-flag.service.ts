import type { FeatureFlag } from '@prisma/client';
import type { Db } from '../../db/db.js';
import { uow } from '../../db/uow.js';
import type { Clock } from '../../foundation/clock.js';
import { planFlagUpsert } from './feature-flag.core.js';
import * as flagRepo from './feature-flag.repo.js';

/**
 * Feature-flag admin use-cases — how flags get INTO the store (the write side of
 * the crepe model). Evaluation/reading is the provider's job
 * (feature-flag.provider.ts); this service is the admin surface a future,
 * staff-gated delivery (an HTTP route or an authorized mutation) would sit on.
 * The module is delivered as a service + provider today — like `auth/` is
 * delivered over HTTP, not GraphQL — so it stays transport-agnostic. (There is
 * no GraphQL surface yet: gannet has no authorization layer to gate an admin
 * mutation the way crepe's `staff` scope does; tests and a future route drive
 * this service directly.)
 */
export interface UpsertFlagInput {
  name: string;
  description?: string | null;
  stage?: string | null;
  value?: string | null;
  enableAfter?: Date | null;
  disableAfter?: Date | null;
}

export function createFeatureFlagService(db: Db, clock: Clock) {
  return {
    /**
     * Creates or updates the LIVE flag named `input.name`: if a live row exists it
     * is updated in place (id stable), otherwise a new live row is inserted — so a
     * fresh upsert after a soft delete recreates the name (a new live row; the old
     * soft-deleted row stays). Decides in the core (stage value set + window
     * ordering), then reads-then-writes in one atomic transaction; the partial
     * unique index (`name` WHERE deletedAt IS NULL) is the race backstop.
     */
    // `async` so a synchronous core rejection (planFlagUpsert) surfaces as a
    // rejected promise, not a thrown call (mirrors point.service.charge).
    async upsert(input: UpsertFlagInput): Promise<FeatureFlag> {
      const write = planFlagUpsert({
        name: input.name,
        description: input.description ?? null,
        stage: input.stage ?? null,
        value: input.value ?? null,
        enableAfter: input.enableAfter ?? null,
        disableAfter: input.disableAfter ?? null,
      });
      return uow.run(db, async (tx) => {
        const live = await flagRepo.findLiveByName(tx, write.name);
        return live ? flagRepo.update(tx, live.id, write) : flagRepo.insert(tx, write);
      });
    },

    /** Soft-deletes the flag with `id` (the crepe kill; its name becomes reusable).
     * The kill instant comes from the injected clock, stamped by this use-case. */
    remove(id: number): Promise<FeatureFlag> {
      return uow.run(db, (tx) => flagRepo.softDelete(tx, id, clock.now()));
    },
  };
}

export type FeatureFlagService = ReturnType<typeof createFeatureFlagService>;
