-- CreateEnum
CREATE TYPE "StockItemStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'DELIVERED', 'DISABLED');

-- CreateTable
CREATE TABLE "OtherProductStockItem" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "StockItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "contentEncrypted" TEXT NOT NULL,
    "label" TEXT,
    "deliveredOrderId" TEXT,
    "deliveredToUserId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtherProductStockItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtherProductStockItem_productId_idx" ON "OtherProductStockItem"("productId");

-- CreateIndex
CREATE INDEX "OtherProductStockItem_status_idx" ON "OtherProductStockItem"("status");

-- CreateIndex
CREATE INDEX "OtherProductStockItem_deliveredOrderId_idx" ON "OtherProductStockItem"("deliveredOrderId");

-- CreateIndex
CREATE INDEX "OtherProductStockItem_createdAt_idx" ON "OtherProductStockItem"("createdAt");

-- AddForeignKey
ALTER TABLE "OtherProductStockItem" ADD CONSTRAINT "OtherProductStockItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
