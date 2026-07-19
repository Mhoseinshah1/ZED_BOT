-- Phase 2.1 — Telegram Stars subscription recovery & operations (ADDITIVE ONLY).
-- Adds recovery-evidence enums/columns, the reconciliation cursor, subscription
-- state-update fields, 7 STARS_SUBSCRIPTION_* notification types + 3 interaction
-- types. No drops, no data changes, no billing effect. Existing rows backfill to
-- LIVE_SUCCESSFUL_PAYMENT / LIVE_EXACT defaults.

-- CreateEnum
CREATE TYPE "TelegramStarsChargeEvidenceSource" AS ENUM ('LIVE_SUCCESSFUL_PAYMENT', 'STAR_TRANSACTION_RECOVERY');

-- CreateEnum
CREATE TYPE "TelegramStarsPeriodEndSource" AS ENUM ('LIVE_EXACT', 'RECOVERED_DERIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_ACTIVATED';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_RENEWED';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_CANCELLED';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_PAST_DUE';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_REQUIRES_ACTION';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_REFUNDED';
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'STARS_SUBSCRIPTION_PRICE_VERSION_CHANGED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationInteractionType" ADD VALUE 'VIEW_SUBSCRIPTION';
ALTER TYPE "NotificationInteractionType" ADD VALUE 'REACTIVATE_SUBSCRIPTION';
ALTER TYPE "NotificationInteractionType" ADD VALUE 'PAYMENT_SUPPORT';

-- AlterTable
ALTER TABLE "TelegramStarsServiceSubscription" ADD COLUMN     "lastSubscriptionUpdateState" TEXT,
ADD COLUMN     "pastDueMarkedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionUpdateAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TelegramStarsSubscriptionCharge" ADD COLUMN     "evidenceSource" "TelegramStarsChargeEvidenceSource" NOT NULL DEFAULT 'LIVE_SUCCESSFUL_PAYMENT',
ADD COLUMN     "periodEndSource" "TelegramStarsPeriodEndSource" NOT NULL DEFAULT 'LIVE_EXACT',
ADD COLUMN     "recoveredAt" TIMESTAMP(3),
ADD COLUMN     "telegramTransactionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TelegramStarsReconciliationCursor" (
    "singletonKey" TEXT NOT NULL DEFAULT 'default',
    "nextOffset" INTEGER NOT NULL DEFAULT 0,
    "bootstrapCompleted" BOOLEAN NOT NULL DEFAULT false,
    "bootstrapStartedAt" TIMESTAMP(3),
    "lastTransactionAt" TIMESTAMP(3),
    "lastTransactionIdHash" TEXT,
    "lastSuccessfulRunAt" TIMESTAMP(3),
    "lastFailedRunAt" TIMESTAMP(3),
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "safeLastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramStarsReconciliationCursor_pkey" PRIMARY KEY ("singletonKey")
);

-- CreateIndex
CREATE INDEX "TelegramStarsSubscriptionCharge_evidenceSource_status_idx" ON "TelegramStarsSubscriptionCharge"("evidenceSource", "status");

