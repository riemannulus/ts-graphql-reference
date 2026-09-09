-- The ledger — one double-entry kernel for every currency.
--
-- Four currencies (PAID_POINT | FREE_POINT | INCOME | MILEAGE), four primitives
-- (MINT | BURN | MOVE | SWAP), four holder kinds (USER | ESCROW | PAYABLE |
-- RECEIVABLE). The RULES live in src/modules/ledger/ledger.core.ts (the single
-- source of truth); the constraints below are the floor a buggy write cannot
-- fall through — the same division as User.status / PointCharge.state.
--
-- Every value set here is kept in sync with a `const` array in the core and
-- guarded by src/tests/integrations/schema-constraints.test.ts, so drift between
-- the code's set and the database's set fails a test instead of a production
-- write.
--
-- New tables are created directly as TIMESTAMPTZ(6): a JS `Date` is an instant,
-- and 20260722000000_point_expiry_and_timestamptz already moved the older
-- columns there.

-- CreateTable
CREATE TABLE "LedgerReference" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "closeReason" TEXT,
    "parentId" TEXT,
    "initiatorUserId" INTEGER,
    "expiresAt" TIMESTAMPTZ(6),
    "openedAt" TIMESTAMPTZ(6) NOT NULL,
    "closedAt" TIMESTAMPTZ(6),

    CONSTRAINT "LedgerReference_pkey" PRIMARY KEY ("id"),
    -- Value sets in sync with REFERENCE_KINDS / REFERENCE_STATES /
    -- CLOSE_REASONS (ledger.core.ts).
    CONSTRAINT "LedgerReference_kind_check" CHECK (
        "kind" IN ('CHARGE', 'ORDER', 'PAYOUT', 'CONVERSION', 'GIFT', 'ADJUST')
    ),
    CONSTRAINT "LedgerReference_state_check" CHECK ("state" IN ('OPEN', 'FUNDED', 'CLOSED')),
    CONSTRAINT "LedgerReference_closeReason_check" CHECK (
        "closeReason" IS NULL OR "closeReason" IN ('SETTLED', 'REVERSED', 'SPLIT', 'VOID')
    ),
    -- CLOSED and "has a close reason" are the same fact; so are CLOSED and
    -- `closedAt`. Storing them separately without tying them together is how a
    -- lifecycle column drifts from the timestamps that explain it.
    CONSTRAINT "LedgerReference_closed_shape_check" CHECK (
        ("state" = 'CLOSED') = ("closeReason" IS NOT NULL)
        AND ("state" = 'CLOSED') = ("closedAt" IS NOT NULL)
    ),
    -- A reference cannot be its own parent (deeper cycles are prevented by the
    -- core, which only ever nests a NEW reference under an existing one).
    CONSTRAINT "LedgerReference_parent_not_self_check" CHECK ("parentId" IS NULL OR "parentId" <> "id")
);

-- CreateTable
CREATE TABLE "LedgerHolder" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" INTEGER,
    "referenceId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LedgerHolder_pkey" PRIMARY KEY ("key"),
    -- Value set in sync with HOLDER_KINDS (ledger.core.ts).
    CONSTRAINT "LedgerHolder_kind_check" CHECK (
        "kind" IN ('USER', 'ESCROW', 'PAYABLE', 'RECEIVABLE')
    ),
    -- A holder is anchored to exactly ONE thing, decided by its kind: a person
    -- (USER / RECEIVABLE) or a money flow (ESCROW / PAYABLE). The database
    -- enforces the shape so `holderKey()` in the core is the only way to name
    -- one and a half-populated row is impossible.
    CONSTRAINT "LedgerHolder_anchor_check" CHECK (
        CASE
            WHEN "kind" IN ('USER', 'RECEIVABLE') THEN "userId" IS NOT NULL AND "referenceId" IS NULL
            ELSE "referenceId" IS NOT NULL AND "userId" IS NULL
        END
    )
);

-- CreateTable
CREATE TABLE "LedgerLot" (
    "id" SERIAL NOT NULL,
    "currency" TEXT NOT NULL,
    "ownerUserId" INTEGER NOT NULL,
    "mintReferenceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "originalAmount" INTEGER NOT NULL,
    "mintedAt" TIMESTAMPTZ(6) NOT NULL,
    "validUntil" TIMESTAMPTZ(6) NOT NULL,
    "cancellableUntil" TIMESTAMPTZ(6),

    CONSTRAINT "LedgerLot_pkey" PRIMARY KEY ("id"),
    -- Only the LOTTED currencies have lots — the scalar ones (INCOME, MILEAGE)
    -- are a single running balance, so a lot row for them is a category error.
    -- In sync with LOTTED_CURRENCIES (ledger.core.ts).
    CONSTRAINT "LedgerLot_currency_check" CHECK ("currency" IN ('PAID_POINT', 'FREE_POINT')),
    -- Value set in sync with LOT_SOURCES (ledger.core.ts).
    CONSTRAINT "LedgerLot_source_check" CHECK (
        "source" IN ('PG', 'IAP', 'GIFT_CARD', 'INCOME_SWAP', 'ADMIN', 'EVENT', 'OPENING')
    ),
    CONSTRAINT "LedgerLot_originalAmount_check" CHECK ("originalAmount" > 0),
    -- The cancellation window closes no later than the lot dies.
    CONSTRAINT "LedgerLot_window_order_check" CHECK (
        "cancellableUntil" IS NULL OR "cancellableUntil" <= "validUntil"
    )
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "seq" SERIAL NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "lotId" INTEGER,
    "fromHolderKey" TEXT,
    "toHolderKey" TEXT,
    "reason" TEXT NOT NULL,
    "swapId" INTEGER,
    "feeKrw" INTEGER NOT NULL DEFAULT 0,
    "externalRef" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LedgerEvent_pkey" PRIMARY KEY ("seq"),
    -- Value sets in sync with EVENT_OPS / CURRENCIES / ACTOR_KINDS (ledger.core.ts).
    CONSTRAINT "LedgerEvent_op_check" CHECK (
        "op" IN ('MINT', 'BURN', 'MOVE', 'SWAP_BURN', 'SWAP_MINT')
    ),
    CONSTRAINT "LedgerEvent_currency_check" CHECK (
        "currency" IN ('PAID_POINT', 'FREE_POINT', 'INCOME', 'MILEAGE')
    ),
    CONSTRAINT "LedgerEvent_actorKind_check" CHECK (
        "actorKind" IN ('USER', 'STAFF', 'SYSTEM', 'WEBHOOK')
    ),
    -- Amounts are magnitudes. Direction is carried by `op` plus the holder
    -- columns, never by a sign — so "sum the events" needs no sign convention
    -- and a negative row cannot quietly reverse a movement.
    CONSTRAINT "LedgerEvent_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "LedgerEvent_feeKrw_check" CHECK ("feeKrw" >= 0),
    -- The op's shape IS its meaning: MINT has only a destination (value enters
    -- the ledger), BURN only a source (it leaves), MOVE both (it stays). The
    -- swap halves inherit the burn/mint shapes and must carry their header.
    CONSTRAINT "LedgerEvent_op_shape_check" CHECK (
        CASE "op"
            WHEN 'MINT' THEN "fromHolderKey" IS NULL AND "toHolderKey" IS NOT NULL AND "swapId" IS NULL
            WHEN 'BURN' THEN "fromHolderKey" IS NOT NULL AND "toHolderKey" IS NULL AND "swapId" IS NULL
            WHEN 'MOVE' THEN "fromHolderKey" IS NOT NULL AND "toHolderKey" IS NOT NULL AND "swapId" IS NULL
            WHEN 'SWAP_BURN' THEN "fromHolderKey" IS NOT NULL AND "toHolderKey" IS NULL AND "swapId" IS NOT NULL
            ELSE "fromHolderKey" IS NULL AND "toHolderKey" IS NOT NULL AND "swapId" IS NOT NULL
        END
    ),
    -- A lotted currency always moves as a named lot; a scalar one never does.
    CONSTRAINT "LedgerEvent_lot_shape_check" CHECK (
        ("currency" IN ('PAID_POINT', 'FREE_POINT')) = ("lotId" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "LedgerBalance" (
    "holderKey" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LedgerBalance_pkey" PRIMARY KEY ("holderKey", "currency"),
    CONSTRAINT "LedgerBalance_currency_check" CHECK (
        "currency" IN ('PAID_POINT', 'FREE_POINT', 'INCOME', 'MILEAGE')
    ),
    -- Law L6 at the database: no holder ever goes negative. What a clawback
    -- cannot recover is MINTed onto a RECEIVABLE holder as a recognized loss —
    -- a positive number in a named place, never an overdrawn wallet.
    CONSTRAINT "LedgerBalance_amount_check" CHECK ("amount" >= 0)
);

-- CreateTable
CREATE TABLE "LedgerLotBalance" (
    "lotId" INTEGER NOT NULL,
    "holderKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "LedgerLotBalance_pkey" PRIMARY KEY ("lotId", "holderKey"),
    CONSTRAINT "LedgerLotBalance_amount_check" CHECK ("amount" >= 0)
);

-- CreateTable
CREATE TABLE "LedgerSwap" (
    "id" SERIAL NOT NULL,
    "referenceId" TEXT NOT NULL,
    "rateKind" TEXT NOT NULL,
    "burnCurrency" TEXT NOT NULL,
    "mintCurrency" TEXT NOT NULL,
    "feePermille" INTEGER NOT NULL,
    "feeKrw" INTEGER NOT NULL,

    CONSTRAINT "LedgerSwap_pkey" PRIMARY KEY ("id"),
    -- Value set in sync with SWAP_RATES' keys (ledger.core.ts). The currency
    -- graph is closed: an edge that is not in this list cannot be recorded.
    CONSTRAINT "LedgerSwap_rateKind_check" CHECK (
        "rateKind" IN ('SETTLE', 'GIFT_CARD_REDEEM', 'POINT_CONVERSION')
    ),
    -- The two currencies may be the SAME. A gift bought with free points and
    -- redeemed into free points is still a swap and not a transfer: the burnt
    -- lots die with the giver's deadline and source, and the recipient gets a
    -- new lot with its own. `rateKind` is what closes the graph, not inequality.
    CONSTRAINT "LedgerSwap_currency_check" CHECK (
        "burnCurrency" IN ('PAID_POINT', 'FREE_POINT', 'INCOME', 'MILEAGE')
        AND "mintCurrency" IN ('PAID_POINT', 'FREE_POINT', 'INCOME', 'MILEAGE')
    ),
    CONSTRAINT "LedgerSwap_feePermille_check" CHECK ("feePermille" BETWEEN 0 AND 1000),
    CONSTRAINT "LedgerSwap_feeKrw_check" CHECK ("feeKrw" >= 0)
);

-- CreateIndex
CREATE INDEX "LedgerReference_state_expiresAt_idx" ON "LedgerReference"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "LedgerReference_parentId_idx" ON "LedgerReference"("parentId");

-- CreateIndex
CREATE INDEX "LedgerHolder_userId_idx" ON "LedgerHolder"("userId");

-- CreateIndex
CREATE INDEX "LedgerHolder_referenceId_idx" ON "LedgerHolder"("referenceId");

-- CreateIndex
CREATE INDEX "LedgerLot_ownerUserId_currency_idx" ON "LedgerLot"("ownerUserId", "currency");

-- CreateIndex
CREATE INDEX "LedgerLot_validUntil_idx" ON "LedgerLot"("validUntil");

-- CreateIndex
-- Replay protection as a plain constraint (concurrency ladder rung 1): a
-- posting is identified by its idempotency key, and `ordinal` makes each of its
-- event rows unique. A duplicate posting collides on the FIRST row, so the
-- service can return the prior result instead of writing the movement twice.
CREATE UNIQUE INDEX "LedgerEvent_idempotencyKey_ordinal_key" ON "LedgerEvent"("idempotencyKey", "ordinal");

-- CreateIndex
CREATE INDEX "LedgerEvent_referenceId_seq_idx" ON "LedgerEvent"("referenceId", "seq");

-- CreateIndex
-- The trial-balance sweep folds one currency at a time, in `seq` order.
CREATE INDEX "LedgerEvent_currency_seq_idx" ON "LedgerEvent"("currency", "seq");

-- CreateIndex
-- "What happened to this account" is the most-run read in a money system, and
-- the log only grows — so both sides of the holder OR are indexed. Without
-- these, one person's history is a sequential scan of every movement ever made.
CREATE INDEX "LedgerEvent_fromHolderKey_seq_idx" ON "LedgerEvent"("fromHolderKey", "seq");

-- CreateIndex
CREATE INDEX "LedgerEvent_toHolderKey_seq_idx" ON "LedgerEvent"("toHolderKey", "seq");

-- CreateIndex
CREATE INDEX "LedgerEvent_lotId_idx" ON "LedgerEvent"("lotId");

-- CreateIndex
CREATE INDEX "LedgerEvent_swapId_idx" ON "LedgerEvent"("swapId");

-- CreateIndex
CREATE INDEX "LedgerBalance_currency_idx" ON "LedgerBalance"("currency");

-- CreateIndex
CREATE INDEX "LedgerLotBalance_holderKey_idx" ON "LedgerLotBalance"("holderKey");

-- CreateIndex
CREATE INDEX "LedgerSwap_referenceId_idx" ON "LedgerSwap"("referenceId");

-- AddForeignKey
ALTER TABLE "LedgerReference" ADD CONSTRAINT "LedgerReference_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LedgerReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerReference" ADD CONSTRAINT "LedgerReference_initiatorUserId_fkey" FOREIGN KEY ("initiatorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerHolder" ADD CONSTRAINT "LedgerHolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerHolder" ADD CONSTRAINT "LedgerHolder_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "LedgerReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLot" ADD CONSTRAINT "LedgerLot_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLot" ADD CONSTRAINT "LedgerLot_mintReferenceId_fkey" FOREIGN KEY ("mintReferenceId") REFERENCES "LedgerReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "LedgerReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "LedgerLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_swapId_fkey" FOREIGN KEY ("swapId") REFERENCES "LedgerSwap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerBalance" ADD CONSTRAINT "LedgerBalance_holderKey_fkey" FOREIGN KEY ("holderKey") REFERENCES "LedgerHolder"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLotBalance" ADD CONSTRAINT "LedgerLotBalance_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "LedgerLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLotBalance" ADD CONSTRAINT "LedgerLotBalance_holderKey_fkey" FOREIGN KEY ("holderKey") REFERENCES "LedgerHolder"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerSwap" ADD CONSTRAINT "LedgerSwap_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "LedgerReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
