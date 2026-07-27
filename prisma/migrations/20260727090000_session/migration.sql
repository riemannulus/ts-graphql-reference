-- The session store — the principal seam (design spec §10.1). A caller's opaque
-- credential (cookie → `Authorization: Bearer` → connectionParams, parsed by
-- src/modules/auth/auth.value.ts) is looked up here, and the UNIQUE index on
-- "accessToken" makes one-row-per-token a *database* fact: a duplicate mint fails
-- at the constraint (concurrency ladder rung 1) instead of resolving two
-- principals. Whether a session is still valid is decided in *code* against the
-- injected clock (auth.service.resolvePrincipal) — which is why "expiresAt"
-- carries no DB default: it is a DOMAIN timestamp stamped by the minting use-case
-- (CONVENTIONS §10 rule 1), never a value the DB clock invents.

-- CreateTable
CREATE TABLE "Session" (
    -- Prisma mints the uuid client-side (`@default(uuid())`), so there is no
    -- `gen_random_uuid()` default here — the id arrives with the INSERT.
    "id" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_accessToken_key" ON "Session"("accessToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
