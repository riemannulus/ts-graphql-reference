-- Point expiry + timestamptz.
--
-- Two coordinated changes, both about handling time correctly (CONVENTIONS §10):
--
-- 1. Point charges gain an EXPIRED terminal state and an `expiredAt` stamp, so a
--    charge past its deadline (rule: point.core.ts `planExpiry`) can be swept.
--    The state value set stays in sync with POINT_CHARGE_STATES, guarded by
--    src/tests/integrations/schema-constraints.test.ts.
--
-- 2. Every instant column moves from `timestamp without time zone` to
--    `timestamptz(6)`. A JS `Date` is an instant (a point on the UTC timeline);
--    `timestamptz` is the column type that stores an instant, so a naive
--    `timestamp` was a latent footgun the moment any `AT TIME ZONE` / KST
--    calendar logic touched it. The `USING … AT TIME ZONE 'UTC'` clause reads the
--    existing naive values as the UTC instants Prisma already wrote them as (a
--    no-op on the fresh databases tests apply migrations to, correct-by-
--    construction for any environment with data). This aligns gannet with crepe,
--    whose columns are already `@db.Timestamptz(6)`.

-- 1. EXPIRED state + expiredAt ------------------------------------------------

ALTER TABLE "PointCharge" DROP CONSTRAINT "PointCharge_state_check";
ALTER TABLE "PointCharge" ADD CONSTRAINT "PointCharge_state_check"
    CHECK ("state" IN ('USABLE', 'CONSUMED', 'EXPIRED'));

ALTER TABLE "PointCharge" ADD COLUMN "expiredAt" TIMESTAMPTZ(6);

-- 2. timestamp → timestamptz(6) ----------------------------------------------

ALTER TABLE "User"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(6) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "Post"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(6) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "PointBalance"
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(6) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "PointCharge"
    ALTER COLUMN "chargedAt" TYPE TIMESTAMPTZ(6) USING "chargedAt" AT TIME ZONE 'UTC';

ALTER TABLE "PointSpend"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "FeatureFlag"
    ALTER COLUMN "enableAfter" TYPE TIMESTAMPTZ(6) USING "enableAfter" AT TIME ZONE 'UTC',
    ALTER COLUMN "disableAfter" TYPE TIMESTAMPTZ(6) USING "disableAfter" AT TIME ZONE 'UTC',
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(6) USING "updatedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "deletedAt" TYPE TIMESTAMPTZ(6) USING "deletedAt" AT TIME ZONE 'UTC';
