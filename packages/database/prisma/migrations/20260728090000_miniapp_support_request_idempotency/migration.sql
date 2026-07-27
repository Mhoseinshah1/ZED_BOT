-- Mini App support request idempotency.
--
-- Forward-only and additive. A browser retry, a double tap or a reload of a
-- hung submit must not create a second ticket or a second reply, and the
-- deduplication has to survive a process restart and hold across several API
-- replicas -- so it lives in PostgreSQL rather than in memory.
--
-- Every Mini App mutation writes exactly one USER message, so uniqueness on the
-- message is uniqueness on the mutation. This mirrors the existing
-- "sourceUpdateId" column, which solves the same problem for inbound Telegram
-- updates.
--
-- NULLable, and NULLs do not collide in a Postgres unique index: every existing
-- row, and every message the bot writes, keeps clientRequestId = NULL.
ALTER TABLE "SupportMessage" ADD COLUMN "clientRequestId" TEXT;

CREATE UNIQUE INDEX "SupportMessage_clientRequestId_key"
  ON "SupportMessage"("clientRequestId");
