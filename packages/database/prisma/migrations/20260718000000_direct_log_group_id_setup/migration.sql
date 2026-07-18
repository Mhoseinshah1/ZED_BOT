-- CreateEnum
CREATE TYPE "LogGroupSetupStatus" AS ENUM ('VALIDATED', 'QUEUED', 'PROVISIONING', 'TESTING', 'ACTIVE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "LogGroupSetupAttempt" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "safeTitle" TEXT NOT NULL,
    "status" "LogGroupSetupStatus" NOT NULL DEFAULT 'VALIDATED',
    "requestedByAdminId" TEXT NOT NULL,
    "previousChatId" BIGINT,
    "previousTitle" TEXT,
    "topicBindings" JSONB,
    "createdTopicCount" INTEGER NOT NULL DEFAULT 0,
    "directTestOk" BOOLEAN NOT NULL DEFAULT false,
    "safeErrorCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "activeSlot" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogGroupSetupAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LogGroupSetupAttempt_idempotencyKey_key" ON "LogGroupSetupAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LogGroupSetupAttempt_status_createdAt_idx" ON "LogGroupSetupAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LogGroupSetupAttempt_chatId_idx" ON "LogGroupSetupAttempt"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "LogGroupSetupAttempt_activeSlot_key" ON "LogGroupSetupAttempt"("activeSlot");

