-- Per-administrator delivery obligations for support notifications.
--
-- The intent table records that an event happened; this records, per
-- administrator, whether they were told. Without it one administrator's success
-- marked the whole event delivered and erased every other administrator's
-- failure.
--
-- A NEW migration rather than an edit to the intent migration: that one is
-- already applied wherever this branch has been deployed, and rewriting an
-- applied migration makes Prisma's checksum diverge from the recorded one.
--
-- Additive and forward-only: a new enum, a new table, two foreign keys. No
-- existing row is read, rewritten or locked for backfill. Intents that already
-- exist simply have no recipient rows yet; the fan-out materializes them the
-- next time the sweep claims them, so an in-flight deploy loses nothing.

-- CreateEnum
CREATE TYPE "SupportRecipientStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "SupportNotificationRecipient" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "status" "SupportRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportNotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- One obligation per administrator per event. This constraint is what makes a
-- retry skip the recipients that already succeeded: the fan-out re-runs with
-- ON CONFLICT DO NOTHING and the existing rows keep their terminal state.
-- CreateIndex
CREATE UNIQUE INDEX "SupportNotificationRecipient_intentId_adminId_key"
    ON "SupportNotificationRecipient"("intentId", "adminId");

-- The sweep's access patterns: work that is due, and claims that outlived the
-- process holding them.
-- CreateIndex
CREATE INDEX "SupportNotificationRecipient_status_nextAttemptAt_idx"
    ON "SupportNotificationRecipient"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SupportNotificationRecipient_status_claimedAt_idx"
    ON "SupportNotificationRecipient"("status", "claimedAt");

-- Aggregate completion asks "is every recipient of this intent terminal?".
-- CreateIndex
CREATE INDEX "SupportNotificationRecipient_intentId_status_idx"
    ON "SupportNotificationRecipient"("intentId", "status");

-- Cascade on both. An obligation to tell a deleted administrator about a
-- deleted event is not an obligation.
-- AddForeignKey
ALTER TABLE "SupportNotificationRecipient"
    ADD CONSTRAINT "SupportNotificationRecipient_intentId_fkey"
    FOREIGN KEY ("intentId") REFERENCES "SupportNotificationIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportNotificationRecipient"
    ADD CONSTRAINT "SupportNotificationRecipient_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
