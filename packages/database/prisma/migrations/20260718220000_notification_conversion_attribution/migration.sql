-- CreateEnum
CREATE TYPE "NotificationAttributionKind" AS ENUM ('DIRECT_CHECKOUT', 'DIRECT_SERVICE', 'ASSISTED_WINBACK');

-- CreateEnum
CREATE TYPE "NotificationAttributionStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- CreateTable
CREATE TABLE "NotificationConversionAttribution" (
    "id" TEXT NOT NULL,
    "kind" "NotificationAttributionKind" NOT NULL,
    "status" "NotificationAttributionStatus" NOT NULL DEFAULT 'ACTIVE',
    "orderId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationType" "AutomatedNotificationType" NOT NULL,
    "interactionType" "NotificationInteractionType" NOT NULL,
    "grossRevenueToman" INTEGER NOT NULL DEFAULT 0,
    "reversedRevenueToman" INTEGER NOT NULL DEFAULT 0,
    "netRevenueToman" INTEGER NOT NULL DEFAULT 0,
    "notificationSentAt" TIMESTAMP(3) NOT NULL,
    "interactionAt" TIMESTAMP(3) NOT NULL,
    "orderCompletedAt" TIMESTAMP(3) NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "evidenceSnapshot" JSONB NOT NULL,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConversionAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConversionAttribution_orderId_key" ON "NotificationConversionAttribution"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationConversionAttribution_interactionId_key" ON "NotificationConversionAttribution"("interactionId");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_status_orderCompletedAt_idx" ON "NotificationConversionAttribution"("status", "orderCompletedAt");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_status_notificationSentAt_idx" ON "NotificationConversionAttribution"("status", "notificationSentAt");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_kind_status_idx" ON "NotificationConversionAttribution"("kind", "status");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_notificationType_status_idx" ON "NotificationConversionAttribution"("notificationType", "status");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_userId_idx" ON "NotificationConversionAttribution"("userId");

-- CreateIndex
CREATE INDEX "NotificationConversionAttribution_notificationId_idx" ON "NotificationConversionAttribution"("notificationId");

