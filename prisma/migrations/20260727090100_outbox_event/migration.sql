-- The transactional outbox (design spec §4.3 — delivery ladder rung 1). A row is
-- enqueued in the SAME transaction as the domain write it describes, and a
-- drainer publishes it to the event bus after that transaction commits, so "the
-- row landed" and "the event went out" can no longer disagree the way a bare
-- publish-after-commit call can. The payload carries IDS ONLY, which is what buys
-- the three properties this table depends on: duplicate delivery is harmless,
-- reordering is harmless, and payload schema evolution is a non-event — a
-- subscription's `resolve` re-fetches current state, so any arrival order yields
-- the same read. "publishedAt" and "failedAt" are decision-relevant timestamps
-- stamped from the APP clock (CONVENTIONS §10 rule 1); "createdAt" is audit-only.

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "topic" TEXT NOT NULL,
    -- The topic key normalized to TEXT; read back through that topic's
    -- `TopicSpec.keyKind` (src/events/event-registry.ts).
    "key" TEXT NOT NULL,
    -- NOT NULL on purpose: a nullable Prisma `Json?` has TWO nulls
    -- (`Prisma.DbNull` vs `Prisma.JsonNull`) and Prisma 7 rejects a bare `null`,
    -- so an empty body is written as `{}` and that ambiguity never exists.
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failedAt" TIMESTAMPTZ(6),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
    -- A delivery counter can never go negative, even through buggy application
    -- code — the direct analogue of "PointBalance_paidAmount_check".
    CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0)
);

-- The drainer's claim scan (`WHERE "publishedAt" IS NULL AND "failedAt" IS NULL
-- ORDER BY "id" FOR UPDATE SKIP LOCKED` — concurrency ladder rung 4). A PARTIAL
-- index, not a plain one, so the scan stays proportional to the QUEUE rather than
-- to the table: published rows and dead-lettered rows leave the index entirely,
-- and retention can lag without slowing delivery. Prisma cannot express a partial
-- index, so — exactly like "FeatureFlag_name_live_key" — it lives only here and
-- must NOT appear as an `@@index` in schema.prisma.
CREATE INDEX "OutboxEvent_pending_idx" ON "OutboxEvent" ("id") WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;
