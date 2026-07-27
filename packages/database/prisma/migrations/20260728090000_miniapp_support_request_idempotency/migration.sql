-- Mini App request idempotency.
--
-- Forward-only and additive. A browser retry, a double tap or a reload of a
-- hung submit must not create a second ticket or a second reply, and the
-- deduplication has to survive a process restart and hold across several API
-- replicas -- so it lives in PostgreSQL rather than in memory or Redis.
--
-- The key is scoped to the USER, never global: two strangers who happen to draw
-- the same random value must not interfere with each other, and a global
-- namespace would additionally let anyone pre-claim keys and deny service to
-- whoever generated one next.
--
-- The row binds the key to what it was used FOR -- the operation, the target
-- ticket for a reply, and a fingerprint of the normalized payload -- so a key
-- replayed with different content is refused instead of silently returning an
-- answer to a different question. It stores RESULT REFERENCES only; the ticket
-- text is already persisted once and copying it here would double the blast
-- radius of a leak for nothing.
--
-- Telegram's own "sourceUpdateId" idempotency on SupportMessage is untouched.
CREATE TABLE "MiniAppRequestIdempotency" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "operation"       TEXT NOT NULL,
    "targetTicketId"  TEXT,
    "fingerprint"     TEXT NOT NULL,
    "resultTicketId"  TEXT NOT NULL,
    "resultMessageId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniAppRequestIdempotency_pkey" PRIMARY KEY ("id")
);

-- The uniqueness that makes a concurrent duplicate lose rather than double-write.
CREATE UNIQUE INDEX "MiniAppRequestIdempotency_userId_clientRequestId_key"
  ON "MiniAppRequestIdempotency"("userId", "clientRequestId");

CREATE INDEX "MiniAppRequestIdempotency_createdAt_idx"
  ON "MiniAppRequestIdempotency"("createdAt");

ALTER TABLE "MiniAppRequestIdempotency"
  ADD CONSTRAINT "MiniAppRequestIdempotency_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
