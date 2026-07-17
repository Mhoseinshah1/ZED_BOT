-- Ops phase (production backups + Telegram operational logging).
--
-- BackupOperation: the durable record behind the BullMQ database-backup
-- queue - one row per backup attempt; the row id is the job idempotency
-- key. No credentials or encryption passwords are ever stored.
-- SystemLogDelivery: per-topic Telegram delivery tracker for SystemLog
-- rows - the log row is always persisted first, delivery is asynchronous,
-- retried and idempotent (unique systemLogId+logTopicId pair).
-- Purely additive: no existing table is modified beyond the new relation.
-- CreateEnum
CREATE TYPE "LogDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER', 'SKIPPED');

-- CreateEnum
CREATE TYPE "BackupOperationStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'VERIFYING', 'VERIFIED', 'CORRUPT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'PRE_UPDATE');

-- CreateTable
CREATE TABLE "SystemLogDelivery" (
    "id" TEXT NOT NULL,
    "systemLogId" TEXT NOT NULL,
    "logTopicId" TEXT,
    "status" "LogDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "telegramMessageId" INTEGER,
    "safeErrorCode" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemLogDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupOperation" (
    "id" TEXT NOT NULL,
    "status" "BackupOperationStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "BackupTrigger" NOT NULL,
    "requestedByAdminId" TEXT,
    "filename" TEXT,
    "sizeBytes" BIGINT,
    "checksumSha256" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "appVersion" TEXT,
    "pgClientVersion" TEXT,
    "safeErrorCode" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemLogDelivery_status_nextAttemptAt_idx" ON "SystemLogDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemLogDelivery_systemLogId_logTopicId_key" ON "SystemLogDelivery"("systemLogId", "logTopicId");

-- CreateIndex
CREATE INDEX "BackupOperation_status_createdAt_idx" ON "BackupOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BackupOperation_completedAt_idx" ON "BackupOperation"("completedAt");

-- CreateIndex
CREATE INDEX "BackupOperation_filename_idx" ON "BackupOperation"("filename");

-- AddForeignKey
ALTER TABLE "SystemLogDelivery" ADD CONSTRAINT "SystemLogDelivery_systemLogId_fkey" FOREIGN KEY ("systemLogId") REFERENCES "SystemLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

