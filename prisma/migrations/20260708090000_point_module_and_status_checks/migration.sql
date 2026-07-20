-- The User.status *transition rules* live in code (src/modules/user/user.state.ts);
-- this CHECK enforces the *value set* at the database, so a corrupt write fails
-- loudly instead of surfacing later as a bad read. Keep the list in sync with
-- USER_STATUSES (guarded by src/tests/integrations/schema-constraints.test.ts).
ALTER TABLE "User" ADD CONSTRAINT "User_status_check"
    CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'));

-- CreateTable
CREATE TABLE "PointBalance" (
    "userId" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "freeAmount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointBalance_pkey" PRIMARY KEY ("userId"),
    -- A balance can never go negative, even through buggy application code.
    CONSTRAINT "PointBalance_paidAmount_check" CHECK ("paidAmount" >= 0),
    CONSTRAINT "PointBalance_freeAmount_check" CHECK ("freeAmount" >= 0),
    CONSTRAINT "PointBalance_totalAmount_check" CHECK ("totalAmount" >= 0)
);

-- CreateTable
CREATE TABLE "PointCharge" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'USABLE',
    "paidAmount" INTEGER NOT NULL,
    "freeAmount" INTEGER NOT NULL,
    "unspentPaidAmount" INTEGER NOT NULL,
    "unspentFreeAmount" INTEGER NOT NULL,
    "chargedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointCharge_pkey" PRIMARY KEY ("id"),
    -- Value set in sync with POINT_CHARGE_STATES (src/modules/point/point.core.ts).
    CONSTRAINT "PointCharge_state_check" CHECK ("state" IN ('USABLE', 'CONSUMED')),
    -- A charge's sides are non-negative, and its unspent remainder can neither
    -- go negative (overdraft) nor exceed what was charged (inflation).
    CONSTRAINT "PointCharge_paidAmount_check" CHECK ("paidAmount" >= 0),
    CONSTRAINT "PointCharge_freeAmount_check" CHECK ("freeAmount" >= 0),
    CONSTRAINT "PointCharge_unspentPaidAmount_check"
        CHECK ("unspentPaidAmount" >= 0 AND "unspentPaidAmount" <= "paidAmount"),
    CONSTRAINT "PointCharge_unspentFreeAmount_check"
        CHECK ("unspentFreeAmount" >= 0 AND "unspentFreeAmount" <= "freeAmount")
);

-- CreateTable
CREATE TABLE "PointSpend" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL,
    "freeAmount" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointSpend_pkey" PRIMARY KEY ("id"),
    -- A recorded spend is non-negative and internally consistent.
    CONSTRAINT "PointSpend_paidAmount_check" CHECK ("paidAmount" >= 0),
    CONSTRAINT "PointSpend_freeAmount_check" CHECK ("freeAmount" >= 0),
    CONSTRAINT "PointSpend_totalAmount_check"
        CHECK ("totalAmount" = "paidAmount" + "freeAmount")
);

-- CreateIndex
CREATE INDEX "PointCharge_userId_state_chargedAt_idx" ON "PointCharge"("userId", "state", "chargedAt");

-- CreateIndex
CREATE INDEX "PointSpend_userId_createdAt_idx" ON "PointSpend"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PointBalance" ADD CONSTRAINT "PointBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointCharge" ADD CONSTRAINT "PointCharge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointSpend" ADD CONSTRAINT "PointSpend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
