-- CreateEnum
CREATE TYPE "OtherProductNamingPolicy" AS ENUM ('ORDER_SHORT_ID', 'TELEGRAM_ID', 'TELEGRAM_USERNAME_WITH_FALLBACK', 'PRODUCT_CODE_AND_ORDER', 'CUSTOM_TEMPLATE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryReference" TEXT,
ADD COLUMN     "namingSnapshot" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "otherNamingPolicy" "OtherProductNamingPolicy",
ADD COLUMN     "otherNamingTemplate" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "namingStrategySnapshot" JSONB;

-- CreateIndex
CREATE INDEX "Order_deliveryReference_idx" ON "Order"("deliveryReference");

