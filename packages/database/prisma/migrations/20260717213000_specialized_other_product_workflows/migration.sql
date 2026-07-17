-- CreateEnum
CREATE TYPE "OtherProductKind" AS ENUM ('GENERIC', 'APPLE_ID', 'AI_ACCOUNT', 'TELEGRAM_PREMIUM', 'GIFT_CARD');

-- CreateEnum
CREATE TYPE "OtherProductFulfillmentProfile" AS ENUM ('MANUAL_DELIVERY', 'STOCK_CREDENTIAL', 'STOCK_CODE', 'PERSONALIZED_SERVICE');

-- CreateEnum
CREATE TYPE "OtherProductStockParser" AS ENUM ('SINGLE_LINE', 'EXPLICIT_SEPARATOR', 'EMAIL_BOUNDARY');

-- CreateEnum
CREATE TYPE "CheckoutCustomerInputStatus" AS ENUM ('COLLECTING', 'SUBMITTED', 'CONSUMED', 'ABANDONED', 'REDACTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OtherProductOrderStatus" ADD VALUE 'AWAITING_STOCK';
ALTER TYPE "OtherProductOrderStatus" ADD VALUE 'STOCK_RESERVED';

-- DropIndex
DROP INDEX "OtherProductStockItem_deliveredOrderId_idx";

-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "otherProductFulfillmentSnapshot" JSONB;

-- AlterTable
ALTER TABLE "OtherProductOrder" ADD COLUMN     "awaitingStockSince" TIMESTAMP(3),
ADD COLUMN     "completionMessageSnapshot" TEXT,
ADD COLUMN     "customerInputEncrypted" TEXT,
ADD COLUMN     "customerInputSchemaSnapshot" JSONB,
ADD COLUMN     "customerInputSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "customerInputSummary" TEXT,
ADD COLUMN     "fulfillmentAdminsNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentProfileSnapshot" "OtherProductFulfillmentProfile",
ADD COLUMN     "kindSnapshot" "OtherProductKind";

-- AlterTable
ALTER TABLE "OtherProductStockItem" ADD COLUMN     "contentFingerprint" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "collectInfoBeforeManualApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "completionMessageTemplate" TEXT,
ADD COLUMN     "customerInputSchema" JSONB,
ADD COLUMN     "otherProductFulfillmentProfile" "OtherProductFulfillmentProfile",
ADD COLUMN     "otherProductKind" "OtherProductKind" NOT NULL DEFAULT 'GENERIC',
ADD COLUMN     "otherProductStockParser" "OtherProductStockParser";

-- CreateTable
CREATE TABLE "CheckoutCustomerInput" (
    "id" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schemaSnapshot" JSONB NOT NULL,
    "valuesEncrypted" TEXT,
    "renderedSafeSummary" TEXT,
    "status" "CheckoutCustomerInputStatus" NOT NULL DEFAULT 'COLLECTING',
    "submittedAt" TIMESTAMP(3),
    "consumedByOtherProductOrderId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutCustomerInput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutCustomerInput_checkoutSessionId_key" ON "CheckoutCustomerInput"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutCustomerInput_consumedByOtherProductOrderId_key" ON "CheckoutCustomerInput"("consumedByOtherProductOrderId");

-- CreateIndex
CREATE INDEX "CheckoutCustomerInput_userId_idx" ON "CheckoutCustomerInput"("userId");

-- CreateIndex
CREATE INDEX "CheckoutCustomerInput_status_updatedAt_idx" ON "CheckoutCustomerInput"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OtherProductStockItem_deliveredOrderId_key" ON "OtherProductStockItem"("deliveredOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OtherProductStockItem_productId_contentFingerprint_key" ON "OtherProductStockItem"("productId", "contentFingerprint");

-- AddForeignKey
ALTER TABLE "CheckoutCustomerInput" ADD CONSTRAINT "CheckoutCustomerInput_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutCustomerInput" ADD CONSTRAINT "CheckoutCustomerInput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutCustomerInput" ADD CONSTRAINT "CheckoutCustomerInput_consumedByOtherProductOrderId_fkey" FOREIGN KEY ("consumedByOtherProductOrderId") REFERENCES "OtherProductOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

