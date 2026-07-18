-- CreateEnum
CREATE TYPE "AutomatedNotificationType" AS ENUM ('SERVICE_EXPIRY', 'SERVICE_TRAFFIC', 'SERVICE_EXPIRED', 'SERVICE_LIMITED', 'TRIAL_NEAR_EXPIRY', 'TRIAL_EXPIRED', 'ABANDONED_CHECKOUT', 'PAYMENT_RETRY', 'CUSTOMER_WINBACK');

-- CreateEnum
CREATE TYPE "AutomatedNotificationCategory" AS ENUM ('SERVICE', 'PAYMENT', 'MARKETING');

-- CreateEnum
CREATE TYPE "AutomatedNotificationStatus" AS ENUM ('SCHEDULED', 'READY', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER', 'CANCELLED', 'SUPPRESSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationInteractionType" AS ENUM ('OPEN_SERVICE', 'RENEW_SERVICE', 'BUY_EXTRA_VOLUME', 'CONTINUE_CHECKOUT', 'VIEW_PRODUCTS', 'DISMISS');

-- CreateTable
CREATE TABLE "AutomatedNotification" (
    "id" TEXT NOT NULL,
    "type" "AutomatedNotificationType" NOT NULL,
    "category" "AutomatedNotificationCategory" NOT NULL,
    "status" "AutomatedNotificationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "userId" TEXT NOT NULL,
    "serviceId" TEXT,
    "checkoutSessionId" TEXT,
    "paymentId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "availableUntil" TIMESTAMP(3),
    "payloadSnapshot" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "telegramMessageId" INTEGER,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomatedNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationInteraction" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationInteractionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timezone" TEXT,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStartMinutes" INTEGER,
    "quietHoursEndMinutes" INTEGER,
    "dailyAutomatedLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceNotificationPreference" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "expiryEnabled" BOOLEAN,
    "trafficEnabled" BOOLEAN,
    "statusEnabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomatedNotification_dedupeKey_key" ON "AutomatedNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutomatedNotification_status_scheduledFor_idx" ON "AutomatedNotification"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "AutomatedNotification_userId_createdAt_idx" ON "AutomatedNotification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomatedNotification_serviceId_type_idx" ON "AutomatedNotification"("serviceId", "type");

-- CreateIndex
CREATE INDEX "AutomatedNotification_checkoutSessionId_type_idx" ON "AutomatedNotification"("checkoutSessionId", "type");

-- CreateIndex
CREATE INDEX "AutomatedNotification_paymentId_type_idx" ON "AutomatedNotification"("paymentId", "type");

-- CreateIndex
CREATE INDEX "NotificationInteraction_userId_createdAt_idx" ON "NotificationInteraction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationInteraction_notificationId_type_key" ON "NotificationInteraction"("notificationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceNotificationPreference_serviceId_key" ON "ServiceNotificationPreference"("serviceId");

-- AddForeignKey
ALTER TABLE "AutomatedNotification" ADD CONSTRAINT "AutomatedNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationInteraction" ADD CONSTRAINT "NotificationInteraction_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "AutomatedNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationInteraction" ADD CONSTRAINT "NotificationInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceNotificationPreference" ADD CONSTRAINT "ServiceNotificationPreference_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

