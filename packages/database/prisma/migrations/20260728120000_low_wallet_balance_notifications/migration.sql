-- Low wallet balance notifications.
--
-- Additive and forward-only. Nothing here reads, writes or derives a wallet
-- balance: `User.balanceToman` stays the single source of truth and this
-- feature only records what the state machine OBSERVED.
--
-- The one User column added is a focused opt-out defaulting to TRUE, so the
-- backfill has an honest signal to respect while the FEATURE itself stays off
-- until an OWNER enables it.

-- --- enums -------------------------------------------------------------------

CREATE TYPE "LowBalanceAlertStateValue" AS ENUM ('ARMED', 'ALERTED');

CREATE TYPE "LowBalanceBackfillStatus" AS ENUM (
    'PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED'
);

-- New automated-notification type. Postgres cannot add an enum value inside a
-- transaction that then USES it, but adding it alone here is safe and the
-- application only emits it after this migration has committed.
ALTER TYPE "AutomatedNotificationType" ADD VALUE IF NOT EXISTS 'WALLET_LOW_BALANCE';

-- --- focused per-user opt-out -------------------------------------------------

-- DEFAULT TRUE with NOT NULL: Postgres 11+ stores this as a catalog default and
-- does NOT rewrite the table, so adding it to a users table with hundreds of
-- thousands of rows does not hold a long ACCESS EXCLUSIVE lock.
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "lowBalanceNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- --- durable per-user state machine ------------------------------------------

CREATE TABLE "LowBalanceAlertState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "LowBalanceAlertStateValue" NOT NULL DEFAULT 'ARMED',
    "alertCycle" INTEGER NOT NULL DEFAULT 0,
    "lastObservedBalanceToman" INTEGER NOT NULL DEFAULT 0,
    "lastThresholdToman" INTEGER NOT NULL DEFAULT 0,
    "lastRearmBoundaryToman" INTEGER NOT NULL DEFAULT 0,
    "lastConfigVersion" INTEGER NOT NULL DEFAULT 1,
    "alertedAt" TIMESTAMP(3),
    "rearmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LowBalanceAlertState_pkey" PRIMARY KEY ("id")
);

-- ONE logical state row per user. This is the constraint that makes two
-- concurrent debits converge on a single alert instead of racing to insert two
-- state rows: the loser of the INSERT re-reads the winner's row.
CREATE UNIQUE INDEX "LowBalanceAlertState_userId_key"
    ON "LowBalanceAlertState"("userId");

-- The reconciliation sweep looks for rows whose recorded state disagrees with
-- the live balance; it filters on (state, lastObservedBalanceToman) and never
-- scans User.
CREATE INDEX "LowBalanceAlertState_state_lastObservedBalanceToman_idx"
    ON "LowBalanceAlertState"("state", "lastObservedBalanceToman");

CREATE INDEX "LowBalanceAlertState_updatedAt_idx"
    ON "LowBalanceAlertState"("updatedAt");

ALTER TABLE "LowBalanceAlertState"
    ADD CONSTRAINT "LowBalanceAlertState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The cycle counter only ever advances; a negative value would corrupt dedupe
-- key derivation.
ALTER TABLE "LowBalanceAlertState"
    ADD CONSTRAINT "LowBalanceAlertState_alertCycle_nonnegative"
    CHECK ("alertCycle" >= 0);

-- --- backfill runs ------------------------------------------------------------

CREATE TABLE "LowBalanceBackfillRun" (
    "id" TEXT NOT NULL,
    "status" "LowBalanceBackfillStatus" NOT NULL DEFAULT 'PENDING',
    "thresholdToman" INTEGER NOT NULL,
    "rearmBoundaryToman" INTEGER NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "createdByAdminId" TEXT,
    "cursorUserId" TEXT,
    "estimatedCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LowBalanceBackfillRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LowBalanceBackfillRun_status_createdAt_idx"
    ON "LowBalanceBackfillRun"("status", "createdAt");

-- AT MOST ONE active backfill, enforced by the database rather than by a
-- read-then-insert check that two admins could both pass. Starting the same
-- operation twice therefore cannot double-notify.
CREATE UNIQUE INDEX "LowBalanceBackfillRun_single_active"
    ON "LowBalanceBackfillRun"((1))
    WHERE "status" IN ('PENDING', 'RUNNING');
