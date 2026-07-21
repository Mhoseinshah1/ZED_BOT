-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "diagnosticSnapshot" JSONB,
ADD COLUMN     "serviceId" TEXT;

-- CreateIndex
CREATE INDEX "SupportTicket_serviceId_idx" ON "SupportTicket"("serviceId");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
