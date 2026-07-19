-- CreateEnum
CREATE TYPE "AutoRenewalMandateStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutoRenewalPauseReason" AS ENUM ('USER_PAUSED', 'ADMIN_PAUSED', 'INSUFFICIENT_BALANCE', 'PRICE_ABOVE_LIMIT', 'PRODUCT_UNAVAILABLE', 'PANEL_UNAVAILABLE', 'SERVICE_INELIGIBLE', 'SERVICE_STATE_UNCERTAIN', 'FINANCIAL_REVIEW', 'FULFILLMENT_REVIEW', 'SYSTEM_DISABLED');

-- CreateEnum
CREATE TYPE "AutoRenewalAttemptStatus" AS ENUM ('SCHEDULED', 'CLAIMED', 'PAYMENT_CREATED', 'FULFILLING', 'COMPLETED', 'INSUFFICIENT_BALANCE', 'REQUIRES_ACTION', 'FAILED', 'DEAD_LETTER', 'CANCELLED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ServiceAutoRenewalMandate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "AutoRenewalMandateStatus" NOT NULL DEFAULT 'ACTIVE',
    "pauseReason" "AutoRenewalPauseReason",
    "maximumChargeToman" INTEGER NOT NULL,
    "consentedPriceToman" INTEGER NOT NULL,
    "chargeLeadMinutes" INTEGER NOT NULL,
    "insufficientBalanceRetryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "consentVersion" INTEGER NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "nextEvaluationAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastSuccessfulOrderId" TEXT,
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "safeLastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAutoRenewalMandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAutoRenewalAttempt" (
    "id" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "AutoRenewalAttemptStatus" NOT NULL DEFAULT 'SCHEDULED',
    "expiryCycleFingerprint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expectedServiceExpiresAt" TIMESTAMP(3),
    "expectedProductPriceToman" INTEGER NOT NULL,
    "authorizedMaximumChargeToman" INTEGER NOT NULL,
    "checkoutSessionId" TEXT,
    "paymentId" TEXT,
    "orderId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "nextAttemptAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,
    "claimedAt" TIMESTAMP(3),
    "paymentCreatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAutoRenewalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAutoRenewalMandate_serviceId_key" ON "ServiceAutoRenewalMandate"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalMandate_status_nextEvaluationAt_idx" ON "ServiceAutoRenewalMandate"("status", "nextEvaluationAt");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalMandate_userId_status_idx" ON "ServiceAutoRenewalMandate"("userId", "status");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalMandate_productId_idx" ON "ServiceAutoRenewalMandate"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAutoRenewalAttempt_idempotencyKey_key" ON "ServiceAutoRenewalAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalAttempt_status_nextAttemptAt_idx" ON "ServiceAutoRenewalAttempt"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalAttempt_serviceId_createdAt_idx" ON "ServiceAutoRenewalAttempt"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceAutoRenewalAttempt_userId_createdAt_idx" ON "ServiceAutoRenewalAttempt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAutoRenewalAttempt_mandateId_expiryCycleFingerprint_key" ON "ServiceAutoRenewalAttempt"("mandateId", "expiryCycleFingerprint");

-- AddForeignKey
ALTER TABLE "ServiceAutoRenewalAttempt" ADD CONSTRAINT "ServiceAutoRenewalAttempt_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "ServiceAutoRenewalMandate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

