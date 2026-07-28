-- AlterTable
ALTER TABLE "CheckoutSession" ADD COLUMN     "origin" TEXT;

-- AlterTable
ALTER TABLE "ManualReceipt" ADD COLUMN     "uploadId" TEXT;

-- AlterTable
ALTER TABLE "MiniAppRequestIdempotency" ADD COLUMN     "resultCheckoutSessionId" TEXT,
ADD COLUMN     "resultPaymentId" TEXT;

-- CreateTable
CREATE TABLE "MiniAppReceiptUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniAppReceiptUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MiniAppReceiptUpload_userId_createdAt_idx" ON "MiniAppReceiptUpload"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MiniAppReceiptUpload_expiresAt_idx" ON "MiniAppReceiptUpload"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualReceipt_uploadId_key" ON "ManualReceipt"("uploadId");

-- AddForeignKey
ALTER TABLE "ManualReceipt" ADD CONSTRAINT "ManualReceipt_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "MiniAppReceiptUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MiniAppReceiptUpload" ADD CONSTRAINT "MiniAppReceiptUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

