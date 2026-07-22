-- Support Tickets V2 (feat/support-ticket-attachments-service-context).
-- Fully additive: every new column is nullable, so all existing SupportTicket /
-- SupportMessage rows remain valid. No column is dropped, narrowed or made NOT
-- NULL; no data is rewritten. No file bytes / download URLs are ever stored —
-- attachments are Telegram file references only.

-- AlterTable: structured category + origin on the ticket (nullable machine codes).
ALTER TABLE "SupportTicket" ADD COLUMN     "category" TEXT,
ADD COLUMN     "origin" TEXT;

-- AlterTable: one optional attachment per message + inbound idempotency key.
ALTER TABLE "SupportMessage" ADD COLUMN     "attachmentType" TEXT,
ADD COLUMN     "fileUniqueId" TEXT,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "fileSizeBytes" BIGINT,
ADD COLUMN     "sourceUpdateId" BIGINT,
ADD COLUMN     "sourceMessageId" INTEGER;

-- CreateIndex: admin category filters ordered by recency.
CREATE INDEX "SupportTicket_category_updatedAt_idx" ON "SupportTicket"("category", "updatedAt");

-- CreateIndex: chronological message reads per ticket.
CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- CreateIndex: unique inbound Telegram update_id (NULLs are not deduplicated by
-- Postgres, so older / SYSTEM rows with NULL coexist freely).
CREATE UNIQUE INDEX "SupportMessage_sourceUpdateId_key" ON "SupportMessage"("sourceUpdateId");
