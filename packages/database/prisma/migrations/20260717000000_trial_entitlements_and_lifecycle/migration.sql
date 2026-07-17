-- Trial-entitlement + trial-lifecycle phase.
--
-- Part 1 (entitlements): FreeTrialEntitlement (admin/campaign allowance
-- rows - the DEFAULT policy allowance stays virtual and is derived from
-- unlinked FreeTrialClaim rows), FreeTrialResetCampaign +
-- FreeTrialCampaignRecipient (the durable, resumable bulk-grant queue),
-- FreeTrialClaim.entitlementId (which allowance funded the claim) and
-- FreeTrialClaim.allowanceReleasedAt (release-exactly-once marker).
--
-- Part 2 (lifecycle): Service.convertedToPaidAt/firstPaidOrderId -
-- trial-to-paid conversion markers stamped exactly once by the first
-- verified, completed paid operation; the immutable Service.source is
-- never overwritten.
--
-- Part 3 (per-user overrides): additive nullable User columns for admin
-- revoke / temporary denial / cooldown override / cooldown waiver /
-- default-allowance override.
--
-- Backfill policy: NONE on purpose. Historical claims keep entitlementId
-- NULL, which the eligibility calculator counts as consumed DEFAULT
-- allowance - existing one-trial semantics are preserved without creating
-- fake admin grants, new eligibility, or evidence-less conversions.

-- CreateEnum
CREATE TYPE "FreeTrialEntitlementScope" AS ENUM ('GLOBAL', 'PANEL');

-- CreateEnum
CREATE TYPE "FreeTrialEntitlementSource" AS ENUM ('DEFAULT_POLICY', 'ADMIN_GRANT', 'ADMIN_RESET', 'CAMPAIGN_RESET', 'COMPENSATION', 'MIGRATION');

-- CreateEnum
CREATE TYPE "FreeTrialEntitlementStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FreeTrialResetCampaignStatus" AS ENUM ('DRAFT', 'PREVIEWED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FreeTrialCampaignRecipientStatus" AS ENUM ('PENDING', 'GRANTED', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "FreeTrialClaim" ADD COLUMN     "allowanceReleasedAt" TIMESTAMP(3),
ADD COLUMN     "entitlementId" TEXT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "convertedToPaidAt" TIMESTAMP(3),
ADD COLUMN     "firstPaidOrderId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "freeTrialCooldownClearedAt" TIMESTAMP(3),
ADD COLUMN     "freeTrialCooldownUntil" TIMESTAMP(3),
ADD COLUMN     "freeTrialDefaultAllowanceOverride" INTEGER,
ADD COLUMN     "freeTrialDeniedUntil" TIMESTAMP(3),
ADD COLUMN     "freeTrialRevokedAt" TIMESTAMP(3),
ADD COLUMN     "freeTrialRevokedByAdminId" TEXT;

-- CreateTable
CREATE TABLE "FreeTrialEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allowance" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "scope" "FreeTrialEntitlementScope" NOT NULL DEFAULT 'GLOBAL',
    "panelId" TEXT,
    "source" "FreeTrialEntitlementSource" NOT NULL,
    "status" "FreeTrialEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdByAdminId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByAdminId" TEXT,
    "campaignId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeTrialEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeTrialResetCampaign" (
    "id" TEXT NOT NULL,
    "status" "FreeTrialResetCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "allowance" INTEGER NOT NULL,
    "audience" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "notifyUsers" BOOLEAN NOT NULL DEFAULT false,
    "includeUsersWithAllowance" BOOLEAN NOT NULL DEFAULT false,
    "createdByAdminId" TEXT NOT NULL,
    "estimatedUsers" INTEGER,
    "totalUsers" INTEGER,
    "processedUsers" INTEGER NOT NULL DEFAULT 0,
    "grantedUsers" INTEGER NOT NULL DEFAULT 0,
    "skippedUsers" INTEGER NOT NULL DEFAULT 0,
    "failedUsers" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "FreeTrialResetCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeTrialCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "FreeTrialCampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "errorMessage" TEXT,
    "entitlementId" TEXT,
    "processedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeTrialCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FreeTrialEntitlement_userId_status_idx" ON "FreeTrialEntitlement"("userId", "status");

-- CreateIndex
CREATE INDEX "FreeTrialEntitlement_panelId_idx" ON "FreeTrialEntitlement"("panelId");

-- CreateIndex
CREATE INDEX "FreeTrialEntitlement_expiresAt_idx" ON "FreeTrialEntitlement"("expiresAt");

-- CreateIndex
CREATE INDEX "FreeTrialEntitlement_campaignId_idx" ON "FreeTrialEntitlement"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTrialEntitlement_idempotencyKey_key" ON "FreeTrialEntitlement"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTrialEntitlement_campaignId_userId_key" ON "FreeTrialEntitlement"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "FreeTrialResetCampaign_status_createdAt_idx" ON "FreeTrialResetCampaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FreeTrialCampaignRecipient_campaignId_status_idx" ON "FreeTrialCampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "FreeTrialCampaignRecipient_userId_idx" ON "FreeTrialCampaignRecipient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FreeTrialCampaignRecipient_campaignId_userId_key" ON "FreeTrialCampaignRecipient"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "FreeTrialClaim_entitlementId_idx" ON "FreeTrialClaim"("entitlementId");

-- CreateIndex
CREATE INDEX "Service_source_convertedToPaidAt_idx" ON "Service"("source", "convertedToPaidAt");

-- AddForeignKey
ALTER TABLE "FreeTrialClaim" ADD CONSTRAINT "FreeTrialClaim_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "FreeTrialEntitlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTrialEntitlement" ADD CONSTRAINT "FreeTrialEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTrialEntitlement" ADD CONSTRAINT "FreeTrialEntitlement_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTrialEntitlement" ADD CONSTRAINT "FreeTrialEntitlement_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "FreeTrialResetCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTrialCampaignRecipient" ADD CONSTRAINT "FreeTrialCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "FreeTrialResetCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreeTrialCampaignRecipient" ADD CONSTRAINT "FreeTrialCampaignRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Authoritative overdraw guards (not expressible in Prisma schema): an
-- allowance can never be negative, consumption can never be negative and
-- can never exceed the allowance. Concurrent reservations rely on these
-- plus conditional UPDATE ... WHERE consumed < allowance.
ALTER TABLE "FreeTrialEntitlement"
  ADD CONSTRAINT "FreeTrialEntitlement_allowance_nonnegative" CHECK ("allowance" >= 0),
  ADD CONSTRAINT "FreeTrialEntitlement_consumed_nonnegative" CHECK ("consumed" >= 0),
  ADD CONSTRAINT "FreeTrialEntitlement_consumed_within_allowance" CHECK ("consumed" <= "allowance");

-- Campaign allowance must be positive (a zero-grant campaign is invalid).
ALTER TABLE "FreeTrialResetCampaign"
  ADD CONSTRAINT "FreeTrialResetCampaign_allowance_positive" CHECK ("allowance" > 0);
