-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationInteractionType" ADD VALUE 'VIEW_WALLET';
ALTER TYPE "NotificationInteractionType" ADD VALUE 'SNOOZE_WINBACK';
ALTER TYPE "NotificationInteractionType" ADD VALUE 'MARKETING_OPT_OUT';

-- CreateTable
CREATE TABLE "CustomerRetentionPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "winbackSnoozedUntil" TIMESTAMP(3),
    "lastSnoozedByNotificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerRetentionPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerRetentionPreference_userId_key" ON "CustomerRetentionPreference"("userId");

-- AddForeignKey
ALTER TABLE "CustomerRetentionPreference" ADD CONSTRAINT "CustomerRetentionPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
