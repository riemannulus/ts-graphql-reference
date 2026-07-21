-- The feature-flag store (the crepe model). A flag is ACTIVE only for a specific
-- deploy stage, inside its [enableAfter, disableAfter] window, and while not
-- soft-deleted; the activation *rule* is the single source of truth in code
-- (src/modules/feature-flag/feature-flag.core.ts `isActive`). These constraints
-- back the *value set*, the *window ordering*, and *one-live-row-per-name* at the
-- database, so even a bypassing writer cannot persist garbage.

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage" TEXT,
    -- Optional payload for a non-boolean flag (the variant an ACTIVE flag resolves
    -- to); NULL for a plain gate. Extends the boolean-only crepe model.
    "value" TEXT,
    "enableAfter" TIMESTAMP(3),
    "disableAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id"),
    -- Value set in sync with STAGES (feature-flag.core.ts). NULL is allowed (a
    -- NULL-stage row is simply never active); a non-NULL value must be known.
    CONSTRAINT "FeatureFlag_stage_check"
        CHECK ("stage" IS NULL OR "stage" IN ('LOCAL', 'DEV', 'QA', 'STG', 'PROD')),
    -- A window cannot end before it starts, even through a buggy admin writer.
    CONSTRAINT "FeatureFlag_window_check"
        CHECK ("disableAfter" IS NULL OR "enableAfter" IS NULL OR "disableAfter" >= "enableAfter")
);

-- At most one LIVE row per name — the provider's findFirst({ name, deletedAt: null })
-- is therefore single-valued. A partial index (not a plain UNIQUE) so a name
-- becomes reusable after a soft delete (crepe recreate-by-name).
CREATE UNIQUE INDEX "FeatureFlag_name_live_key" ON "FeatureFlag"("name") WHERE "deletedAt" IS NULL;

-- The provider's read path (name lookup among live rows).
CREATE INDEX "FeatureFlag_name_idx" ON "FeatureFlag"("name");
