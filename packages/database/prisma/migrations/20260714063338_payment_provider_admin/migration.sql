-- AlterTable
ALTER TABLE "PaymentGateway" ADD COLUMN     "description" TEXT,
ADD COLUMN     "healthStatus" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3);

