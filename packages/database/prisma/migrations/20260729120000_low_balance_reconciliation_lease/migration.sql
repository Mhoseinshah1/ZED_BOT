-- Low wallet balance notifications: durable reconciliation lease + worker claim.
--
-- Forward-only and additive. The released migration
-- 20260728120000_low_wallet_balance_notifications is NOT modified.
--
-- WHY A LEASE. The first cut guarded the reconciliation sweep with a
-- session-level pg_try_advisory_lock taken through Prisma's connection pool.
-- That is unsafe: the lock and the matching unlock can be issued on different
-- pooled connections, so the lock may be released by a session that does not
-- hold it, or leak until the connection is recycled. A durable lease row has
-- neither failure mode and additionally survives a worker crash, because an
-- expired lease is simply taken over.
--
-- WHY A CURSOR. The sweep pages by keyset. Without a persisted cursor every
-- invocation restarts from the beginning, so on a large installation the first
-- page is rescanned forever and later rows are never repaired. The cursor is
-- committed with each batch and wraps to the start on completion.

-- --- backfill run: durable worker claim -------------------------------------
ALTER TABLE "LowBalanceBackfillRun"
  ADD COLUMN IF NOT EXISTS "ownerToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

-- --- reconciliation control record -------------------------------------------
CREATE TABLE IF NOT EXISTS "LowBalanceReconciliationState" (
  "singletonKey"         TEXT         NOT NULL DEFAULT 'default',
  "ownerToken"           TEXT,
  "leaseExpiresAt"       TIMESTAMP(3),
  "initCursorUserId"     TEXT,
  "repairCursorId"       TEXT,
  "lastSweepStartedAt"   TIMESTAMP(3),
  "lastSweepCompletedAt" TIMESTAMP(3),
  "completedSweepCount"  INTEGER      NOT NULL DEFAULT 0,
  "safeLastErrorCode"    TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LowBalanceReconciliationState_pkey" PRIMARY KEY ("singletonKey")
);

-- A non-negative sweep counter is an invariant, not a convention.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'LowBalanceReconciliationState_completedSweepCount_check'
  ) THEN
    ALTER TABLE "LowBalanceReconciliationState"
      ADD CONSTRAINT "LowBalanceReconciliationState_completedSweepCount_check"
      CHECK ("completedSweepCount" >= 0);
  END IF;
END
$$;

-- Seed the single row so lease acquisition is a pure conditional UPDATE.
INSERT INTO "LowBalanceReconciliationState" ("singletonKey")
VALUES ('default')
ON CONFLICT ("singletonKey") DO NOTHING;
