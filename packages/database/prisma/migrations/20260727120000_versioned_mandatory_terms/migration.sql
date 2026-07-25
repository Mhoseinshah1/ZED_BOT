-- Versioned mandatory Terms & Conditions.
--
-- Forward-only and additive: no existing migration is edited, no existing column
-- is dropped and `User"."termsAcceptedAt"` is deliberately preserved as the
-- legacy "latest acceptance" timestamp.
--
-- The tail of this migration performs the one-time legacy bootstrap: if this
-- installation already has a configured `terms_text` with meaningful content, it
-- becomes published version 1 and every user who had already accepted the old
-- single-text terms gets a version-1 acceptance row carrying their ORIGINAL
-- timestamp — so upgrading never silently forces the whole user base to accept
-- again. On a fresh database the MessageTemplate registry is still empty at
-- migration time (seeding runs afterwards), so no document is fabricated.
--
-- Everything reported by this migration is a COUNT. No user identity, no
-- Telegram id and no terms body is ever emitted.

-- CreateEnum
CREATE TYPE "TermsDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "TermsDocument" (
    "id" TEXT NOT NULL,
    "version" INTEGER,
    "body" TEXT NOT NULL,
    "status" "TermsDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "contentHash" TEXT,
    "createdByAdminId" TEXT,
    "publishedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "TermsDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "termsDocumentId" TEXT NOT NULL,
    "termsVersion" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TermsDocument_version_key" ON "TermsDocument"("version");

-- CreateIndex
CREATE INDEX "TermsDocument_status_version_idx" ON "TermsDocument"("status", "version");

-- CreateIndex
CREATE INDEX "TermsDocument_status_createdAt_idx" ON "TermsDocument"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAcceptance_userId_termsDocumentId_key" ON "TermsAcceptance"("userId", "termsDocumentId");

-- CreateIndex
CREATE INDEX "TermsAcceptance_termsDocumentId_acceptedAt_idx" ON "TermsAcceptance"("termsDocumentId", "acceptedAt");

-- CreateIndex
CREATE INDEX "TermsAcceptance_userId_termsVersion_idx" ON "TermsAcceptance"("userId", "termsVersion");

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_termsDocumentId_fkey" FOREIGN KEY ("termsDocumentId") REFERENCES "TermsDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Database-level invariants that the Prisma DSL cannot express.
-- ---------------------------------------------------------------------------

-- AT MOST ONE published document, enforced by the database itself rather than by
-- application code alone. Combined with the transaction-level advisory lock the
-- publish path takes, a concurrent double-publish loses at COMMIT instead of
-- leaving two "current" documents behind.
CREATE UNIQUE INDEX "TermsDocument_single_published_key"
    ON "TermsDocument" ((1)) WHERE "status" = 'PUBLISHED';

-- A DRAFT has no version yet (it is assigned atomically at publish time); a
-- PUBLISHED or ARCHIVED document always has one. This makes "published document
-- without a version" and "draft that already claimed a version" unrepresentable.
ALTER TABLE "TermsDocument"
    ADD CONSTRAINT "TermsDocument_version_status_check"
    CHECK (("status" = 'DRAFT') = ("version" IS NULL));

-- ---------------------------------------------------------------------------
-- One-time legacy bootstrap (idempotent: guarded on "no document exists yet").
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    legacy_body     TEXT;
    new_document_id TEXT;
    accepted_users  INTEGER := 0;
BEGIN
    -- Nothing to migrate if some document already exists (re-run safety).
    IF EXISTS (SELECT 1 FROM "TermsDocument") THEN
        RAISE NOTICE 'Versioned terms: documents already present, skipping bootstrap.';
        RETURN;
    END IF;

    -- The MessageTemplate registry may not exist in an exotic/custom schema.
    IF to_regclass('"MessageTemplate"') IS NULL THEN
        RAISE NOTICE 'Versioned terms: no MessageTemplate registry, skipping bootstrap.';
        RETURN;
    END IF;

    SELECT "currentContent" INTO legacy_body
    FROM "MessageTemplate"
    WHERE "key" = 'terms_text'
    LIMIT 1;

    -- "Meaningful" = present and not merely whitespace / zero-width filler
    -- (ZWSP, ZWNJ, ZWJ, BOM, NBSP are stripped before the emptiness test, so a
    -- body made only of invisible characters does not become "version 1"). The
    -- body itself is never written to the log.
    IF legacy_body IS NULL
       OR regexp_replace(
            translate(legacy_body, U&'\200B\200C\200D\FEFF\00A0', ''),
            '[[:space:]]', '', 'g'
          ) = '' THEN
        RAISE NOTICE 'Versioned terms: no meaningful legacy terms text, skipping bootstrap.';
        RETURN;
    END IF;

    -- Normalize exactly as the application does before storing, and bound the
    -- length to the same 3,500-character limit the app enforces. Without this a
    -- legacy `terms_text` could publish a 4,000-character version 1 containing
    -- bidi overrides and control characters — permanently, since published
    -- documents are never modified in place — and the rendered terms screen
    -- would exceed Telegram's message limit.
    legacy_body := btrim(
        regexp_replace(
            translate(
                legacy_body,
                U&'\200B\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069\FEFF',
                ''
            ),
            U&'[\0001-\0008\000B-\001F\007F-\009F]', '', 'g'
        )
    );
    IF length(legacy_body) > 3500 THEN
        legacy_body := left(legacy_body, 3500);
        RAISE NOTICE 'Versioned terms: legacy terms text truncated to the 3500-character limit.';
    END IF;

    -- Re-check after normalization: a body of nothing but invisible characters
    -- is not meaningful content.
    IF legacy_body = '' THEN
        RAISE NOTICE 'Versioned terms: legacy terms text is not meaningful after normalization, skipping bootstrap.';
        RETURN;
    END IF;

    new_document_id := gen_random_uuid()::TEXT;

    INSERT INTO "TermsDocument" (
        "id", "version", "body", "status", "contentHash",
        "createdByAdminId", "publishedByAdminId",
        "createdAt", "updatedAt", "publishedAt"
    ) VALUES (
        new_document_id, 1, legacy_body, 'PUBLISHED',
        encode(sha256(convert_to(legacy_body, 'UTF8')), 'hex'),
        NULL, NULL,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    -- Everyone who had already accepted the legacy terms keeps their acceptance,
    -- carrying their ORIGINAL timestamp — they are NOT asked to accept again.
    INSERT INTO "TermsAcceptance" (
        "id", "userId", "termsDocumentId", "termsVersion", "acceptedAt", "source"
    )
    SELECT gen_random_uuid()::TEXT, u."id", new_document_id, 1, u."termsAcceptedAt", 'MIGRATION'
    FROM "User" u
    WHERE u."termsAcceptedAt" IS NOT NULL
    ON CONFLICT ("userId", "termsDocumentId") DO NOTHING;

    GET DIAGNOSTICS accepted_users = ROW_COUNT;

    RAISE NOTICE 'Versioned terms: published version 1 and backfilled % acceptance row(s).', accepted_users;
END
$$;
