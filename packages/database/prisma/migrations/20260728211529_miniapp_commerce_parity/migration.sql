-- AlterTable
ALTER TABLE "MiniAppRequestIdempotency" ADD COLUMN     "resultCheckoutSessionId" TEXT,
ADD COLUMN     "resultPaymentId" TEXT;
