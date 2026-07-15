-- CreateEnum
CREATE TYPE "PaymentSettlementStatus" AS ENUM ('UNSETTLED', 'SETTLED', 'DUPLICATE_SUCCESS_REVIEW');

-- CreateEnum
CREATE TYPE "FinancialReconciliationType" AS ENUM ('DUPLICATE_CHECKOUT_PAYMENT');

-- CreateEnum
CREATE TYPE "FinancialReconciliationStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED');

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "settledByPaymentId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settlementReason" TEXT,
ADD COLUMN     "settlementStatus" "PaymentSettlementStatus" NOT NULL DEFAULT 'UNSETTLED';


-- ============================================================================
-- BACKFILL (safe, additive - no rows deleted, no balances touched, no
-- remote calls). Runs BEFORE the unique constraints below so historical
-- data is normalized first; if genuinely ambiguous duplicates exist (two
-- Orders or two DiscountCodeUsages for one checkout), the unique index
-- creation FAILS SAFELY and the pre-migration audit queries in
-- docs/financial-reconciliation.md identify the rows for manual review.
-- ============================================================================

-- Every historically APPROVED payment settled its checkout under the old
-- model: mark it locally SETTLED (provider truth is untouched).
UPDATE "Payment"
SET "settlementStatus" = 'SETTLED',
    "settledAt" = COALESCE("paidAt", "updatedAt")
WHERE "status" = 'APPROVED';

-- Unambiguous checkout ownership: a settled checkout with EXACTLY ONE
-- APPROVED payment gets that payment as its owner. Checkouts with multiple
-- APPROVED payments (the pre-fix double-settle victims) are deliberately
-- left with NO winner - the audit queries report them for manual review;
-- every Payment row is preserved.
UPDATE "CheckoutSession" AS c
SET "settledByPaymentId" = single."paymentId"
FROM (
  SELECT "checkoutSessionId", MIN("id") AS "paymentId"
  FROM "Payment"
  WHERE "status" = 'APPROVED' AND "checkoutSessionId" IS NOT NULL
  GROUP BY "checkoutSessionId"
  HAVING COUNT(*) = 1
) AS single
WHERE c."id" = single."checkoutSessionId"
  AND c."status" IN ('PAID', 'COMPLETED')
  AND c."settledByPaymentId" IS NULL;

-- CreateTable
CREATE TABLE "FinancialReconciliationCase" (
    "id" TEXT NOT NULL,
    "type" "FinancialReconciliationType" NOT NULL,
    "status" "FinancialReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "checkoutSessionId" TEXT NOT NULL,
    "primaryPaymentId" TEXT,
    "duplicatePaymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expectedAmountToman" INTEGER NOT NULL,
    "safeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" TEXT,

    CONSTRAINT "FinancialReconciliationCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialReconciliationCase_duplicatePaymentId_key" ON "FinancialReconciliationCase"("duplicatePaymentId");

-- CreateIndex
CREATE INDEX "FinancialReconciliationCase_status_createdAt_idx" ON "FinancialReconciliationCase"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialReconciliationCase_checkoutSessionId_idx" ON "FinancialReconciliationCase"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "FinancialReconciliationCase_primaryPaymentId_idx" ON "FinancialReconciliationCase"("primaryPaymentId");

-- CreateIndex
CREATE INDEX "FinancialReconciliationCase_userId_idx" ON "FinancialReconciliationCase"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_settledByPaymentId_key" ON "CheckoutSession"("settledByPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCodeUsage_checkoutSessionId_key" ON "DiscountCodeUsage"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_checkoutSessionId_key" ON "Order"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "Payment_settlementStatus_idx" ON "Payment"("settlementStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_externalTransactionId_key" ON "Payment"("provider", "externalTransactionId");

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_settledByPaymentId_fkey" FOREIGN KEY ("settledByPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

