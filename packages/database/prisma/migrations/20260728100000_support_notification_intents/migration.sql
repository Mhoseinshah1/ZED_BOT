-- Support notification intents.
--
-- The decision to notify support is recorded in the SAME transaction as the
-- message that caused it, so a committed message always has its intent and a
-- rolled-back one has neither. Delivery is a separate, retryable step, which is
-- what lets a process with no bot token (the API) cause a notification at all.
--
-- Additive and forward-only: a new enum, a new table and two foreign keys. No
-- existing row is read, rewritten or locked for backfill, so this deploys
-- against a live database without a maintenance window.

-- CreateEnum
CREATE TYPE "SupportNotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "SupportNotificationIntent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "SupportNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportNotificationIntent_pkey" PRIMARY KEY ("id")
);

-- One intent per message per kind. This is the deduplication mechanism: the
-- constraint decides, rather than a read-then-write that races itself and tells
-- the admins twice about one reply.
-- CreateIndex
CREATE UNIQUE INDEX "SupportNotificationIntent_messageId_kind_key"
    ON "SupportNotificationIntent"("messageId", "kind");

-- The sweep's two access patterns: due work, and claims that outlived the
-- process holding them.
-- CreateIndex
CREATE INDEX "SupportNotificationIntent_status_nextAttemptAt_idx"
    ON "SupportNotificationIntent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SupportNotificationIntent_status_claimedAt_idx"
    ON "SupportNotificationIntent"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "SupportNotificationIntent_ticketId_idx"
    ON "SupportNotificationIntent"("ticketId");

-- Cascade on both: an intent describes a message, so an intent whose message is
-- gone has nothing left to render and must not outlive it as an orphan.
-- AddForeignKey
ALTER TABLE "SupportNotificationIntent"
    ADD CONSTRAINT "SupportNotificationIntent_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportNotificationIntent"
    ADD CONSTRAINT "SupportNotificationIntent_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
