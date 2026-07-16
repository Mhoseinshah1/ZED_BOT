-- Free-trial phase. Additive + a data-preserving RENAME of the unused
-- TestAccountHistory placeholder into FreeTrialClaim (its rows, if any,
-- keep their id/userId/panelId/serviceId/createdAt; new lifecycle columns
-- start at safe defaults). No Service/Payment/Order rows are touched, no
-- balances change, no claims are fabricated, existing panels stay
-- trial-disabled and existing services stay PAID.

-- CreateEnum
CREATE TYPE "ServiceSource" AS ENUM ('PAID', 'FREE_TRIAL', 'ADMIN_CREATED');

-- CreateEnum
CREATE TYPE "FreeTrialClaimStatus" AS ENUM ('CLAIMED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'EXPIRED', 'CANCELLED', 'MANUAL_REVIEW');

-- AlterTable (new per-panel trial settings; every existing panel keeps
-- trials disabled because testEnabled already defaults to false)
ALTER TABLE "Panel" ADD COLUMN     "testAutoDisableAfterExpiry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "testInboundIds" JSONB,
ADD COLUMN     "testMaxConcurrentAccounts" INTEGER;

-- AlterTable (entitlement origin; ALL existing services stay PAID)
ALTER TABLE "Service" ADD COLUMN     "source" "ServiceSource" NOT NULL DEFAULT 'PAID';

-- ============================================================================
-- TestAccountHistory -> FreeTrialClaim: rename in place (the placeholder was
-- never written by any code path, but a rename preserves any manual rows).
-- ============================================================================

ALTER TABLE "TestAccountHistory" RENAME TO "FreeTrialClaim";
ALTER TABLE "FreeTrialClaim" RENAME CONSTRAINT "TestAccountHistory_pkey" TO "FreeTrialClaim_pkey";
ALTER TABLE "FreeTrialClaim" RENAME CONSTRAINT "TestAccountHistory_userId_fkey" TO "FreeTrialClaim_userId_fkey";
ALTER TABLE "FreeTrialClaim" RENAME CONSTRAINT "TestAccountHistory_panelId_fkey" TO "FreeTrialClaim_panelId_fkey";
ALTER TABLE "FreeTrialClaim" RENAME CONSTRAINT "TestAccountHistory_serviceId_fkey" TO "FreeTrialClaim_serviceId_fkey";
ALTER INDEX "TestAccountHistory_userId_idx" RENAME TO "FreeTrialClaim_userId_idx";
ALTER INDEX "TestAccountHistory_panelId_idx" RENAME TO "FreeTrialClaim_panelId_idx";
ALTER INDEX "TestAccountHistory_createdAt_idx" RENAME TO "FreeTrialClaim_createdAt_idx";

-- Lifecycle columns. Any pre-existing manual rows become CANCELLED (they
-- carry no lifecycle evidence and must never consume a user's entitlement -
-- the migration never marks a user as having used a trial without proof).
ALTER TABLE "FreeTrialClaim"
ADD COLUMN     "status" "FreeTrialClaimStatus" NOT NULL DEFAULT 'CLAIMED',
ADD COLUMN     "usernameSnapshot" TEXT,
ADD COLUMN     "namingSnapshot" JSONB,
ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "trafficBytes" BIGINT,
ADD COLUMN     "provisionedAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "failureReasonCode" TEXT,
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "FreeTrialClaim" SET "status" = 'CANCELLED', "failureReasonCode" = 'legacy placeholder row';

-- CreateIndex
CREATE INDEX "FreeTrialClaim_status_createdAt_idx" ON "FreeTrialClaim"("status", "createdAt");

-- ============================================================================
-- THE ATOMIC CLAIM GUARD: at most ONE in-progress/active free-trial claim
-- per user, enforced by the database. FAILED/CANCELLED rows never block a
-- retry; EXPIRED rows are excluded so the lifetime/cooldown policy stays
-- admin-configurable (enforced transactionally in the service on top of
-- this hard concurrency guarantee).
-- ============================================================================
CREATE UNIQUE INDEX "FreeTrialClaim_userId_live_key" ON "FreeTrialClaim"("userId")
WHERE "status" IN ('CLAIMED', 'PROVISIONING', 'ACTIVE', 'MANUAL_REVIEW');
