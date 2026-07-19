-- CreateEnum
CREATE TYPE "AutoRenewalFundingMethod" AS ENUM ('WALLET', 'TELEGRAM_STARS');

-- CreateEnum
CREATE TYPE "TelegramStarsSubscriptionStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'CANCEL_AT_PERIOD_END', 'REACTIVATION_ALLOWED', 'PAST_DUE', 'EXPIRED', 'REQUIRES_ACTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TelegramStarsSubscriptionChargeStatus" AS ENUM ('RECEIVED', 'SETTLING', 'FULFILLING', 'COMPLETED', 'RECONCILIATION_REQUIRED', 'REFUND_PENDING', 'REFUNDED', 'FAILED', 'IGNORED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentPurpose" ADD VALUE 'SERVICE_SUBSCRIPTION_INITIAL';
ALTER TYPE "PaymentPurpose" ADD VALUE 'SERVICE_SUBSCRIPTION_RECURRING';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "telegramStarsSubscriptionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "telegramStarsSubscriptionPrice" INTEGER,
ADD COLUMN     "telegramStarsSubscriptionVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ServiceAutoRenewalMandate" ADD COLUMN     "fundingMethod" "AutoRenewalFundingMethod" NOT NULL DEFAULT 'WALLET';

-- CreateTable
CREATE TABLE "TelegramStarsServiceSubscription" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "TelegramStarsSubscriptionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "publicPayloadId" TEXT NOT NULL,
    "starsAmount" INTEGER NOT NULL,
    "subscriptionPeriodSeconds" INTEGER NOT NULL DEFAULT 2592000,
    "productVersion" INTEGER NOT NULL,
    "entitlementSnapshot" JSONB NOT NULL,
    "consentVersion" INTEGER NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "initialPaymentId" TEXT,
    "initialTelegramPaymentChargeId" TEXT,
    "currentPeriodStartedAt" TIMESTAMP(3),
    "currentPeriodEndsAt" TIMESTAMP(3),
    "nextExpectedChargeAt" TIMESTAMP(3),
    "telegramExtensionCanceled" BOOLEAN NOT NULL DEFAULT false,
    "cancellationRequestedAt" TIMESTAMP(3),
    "cancellationConfirmedAt" TIMESTAMP(3),
    "reactivationRequestedAt" TIMESTAMP(3),
    "lastChargeAt" TIMESTAMP(3),
    "lastSuccessfulOrderId" TEXT,
    "safeLastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramStarsServiceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramStarsSubscriptionCharge" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "telegramPaymentChargeId" TEXT NOT NULL,
    "providerPaymentChargeId" TEXT,
    "starsAmount" INTEGER NOT NULL,
    "isFirstRecurring" BOOLEAN NOT NULL,
    "subscriptionExpirationDate" TIMESTAMP(3) NOT NULL,
    "status" "TelegramStarsSubscriptionChargeStatus" NOT NULL DEFAULT 'RECEIVED',
    "paymentId" TEXT,
    "checkoutSessionId" TEXT,
    "orderId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settlementStartedAt" TIMESTAMP(3),
    "fulfillmentStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "refundRequestedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "refundAttempts" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramStarsSubscriptionCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsServiceSubscription_mandateId_key" ON "TelegramStarsServiceSubscription"("mandateId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsServiceSubscription_serviceId_key" ON "TelegramStarsServiceSubscription"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsServiceSubscription_publicPayloadId_key" ON "TelegramStarsServiceSubscription"("publicPayloadId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsServiceSubscription_initialTelegramPaymentChar_key" ON "TelegramStarsServiceSubscription"("initialTelegramPaymentChargeId");

-- CreateIndex
CREATE INDEX "TelegramStarsServiceSubscription_status_nextExpectedChargeA_idx" ON "TelegramStarsServiceSubscription"("status", "nextExpectedChargeAt");

-- CreateIndex
CREATE INDEX "TelegramStarsServiceSubscription_userId_status_idx" ON "TelegramStarsServiceSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "TelegramStarsServiceSubscription_productId_idx" ON "TelegramStarsServiceSubscription"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsSubscriptionCharge_telegramPaymentChargeId_key" ON "TelegramStarsSubscriptionCharge"("telegramPaymentChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsSubscriptionCharge_paymentId_key" ON "TelegramStarsSubscriptionCharge"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsSubscriptionCharge_checkoutSessionId_key" ON "TelegramStarsSubscriptionCharge"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramStarsSubscriptionCharge_orderId_key" ON "TelegramStarsSubscriptionCharge"("orderId");

-- CreateIndex
CREATE INDEX "TelegramStarsSubscriptionCharge_subscriptionId_receivedAt_idx" ON "TelegramStarsSubscriptionCharge"("subscriptionId", "receivedAt");

-- CreateIndex
CREATE INDEX "TelegramStarsSubscriptionCharge_status_createdAt_idx" ON "TelegramStarsSubscriptionCharge"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalMandate_fundingMethod_status_idx" ON "ServiceAutoRenewalMandate"("fundingMethod", "status");

-- AddForeignKey
ALTER TABLE "TelegramStarsServiceSubscription" ADD CONSTRAINT "TelegramStarsServiceSubscription_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "ServiceAutoRenewalMandate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramStarsSubscriptionCharge" ADD CONSTRAINT "TelegramStarsSubscriptionCharge_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TelegramStarsServiceSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

