-- AlterEnum
ALTER TYPE "SupportMessageSenderType" ADD VALUE 'SYSTEM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SupportTicketStatus" ADD VALUE 'WAITING_ADMIN';
ALTER TYPE "SupportTicketStatus" ADD VALUE 'WAITING_USER';

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "closedByAdminId" TEXT;

-- CreateIndex
CREATE INDEX "SupportTicket_userId_updatedAt_idx" ON "SupportTicket"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_status_updatedAt_idx" ON "SupportTicket"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_closedByAdminId_fkey" FOREIGN KEY ("closedByAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
