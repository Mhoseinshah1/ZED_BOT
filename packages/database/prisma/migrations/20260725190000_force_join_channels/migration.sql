-- Mandatory channel membership / Force Join (feat/mandatory-channel-membership).
--
-- Additive and forward-only: introduces a single new table. It creates NO data,
-- alters NO existing table, and leaves the existing `force_join_enabled` Setting
-- and `force_join_text` message template untouched (they are reused, not
-- duplicated). `User.forceJoinBypass` is unchanged.
--
-- `chatId` is the internal Telegram peer id (the `-100…` form). It is globally
-- unique across ALL rows (D5) so rebinding a channel updates the existing row
-- rather than inserting a second one. `normalizedLink` is unique ONLY among
-- public rows (D6); the partial unique index below is written by hand because
-- Prisma cannot express a filtered unique constraint in the schema DSL.

-- CreateTable
CREATE TABLE "ForceJoinChannel" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "normalizedLink" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "publicUsername" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationErrorCode" TEXT,

    CONSTRAINT "ForceJoinChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (D5: chatId globally unique; rebind updates the row).
CREATE UNIQUE INDEX "ForceJoinChannel_chatId_key" ON "ForceJoinChannel"("chatId");

-- CreateIndex (active-set ordering + deterministic sort — T7).
CREATE INDEX "ForceJoinChannel_isActive_sortOrder_createdAt_id_idx" ON "ForceJoinChannel"("isActive", "sortOrder", "createdAt", "id");

-- CreateIndex (D6: normalizedLink unique ONLY among public channels; private
-- rows are excluded, so re-binding or re-adding private channels never trips it).
CREATE UNIQUE INDEX "ForceJoinChannel_normalizedLink_public_key" ON "ForceJoinChannel"("normalizedLink") WHERE "isPrivate" = false;
