-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "authority" TEXT,
ADD COLUMN     "externalReference" TEXT,
ADD COLUMN     "provider" "PaymentGatewayType",
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_authority_key" ON "Payment"("authority");

-- CreateIndex
CREATE INDEX "Payment_provider_status_idx" ON "Payment"("provider", "status");

-- CreateIndex
CREATE INDEX "Payment_externalReference_idx" ON "Payment"("externalReference");

