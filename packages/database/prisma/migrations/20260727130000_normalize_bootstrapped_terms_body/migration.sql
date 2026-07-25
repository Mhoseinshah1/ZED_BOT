-- Forward-only repair for 20260727120000_versioned_mandatory_terms.
--
-- That migration bootstrapped version 1 from the legacy `terms_text` template
-- VERBATIM. The application normalizes a terms body before storing it (bidi
-- overrides, direction marks, isolates, zero-width space and BOM removed, plus
-- C0/C1 control characters) and bounds it to the same 3,500-character limit the
-- admin UI enforces. A legacy template carrying any of those would therefore
-- have been published as a version 1 the admin UI itself could never produce,
-- and an over-long one renders a terms screen past Telegram's message limit —
-- which the user-facing view now refuses to offer for acceptance at all.
--
-- The previous migration is already released, so it is left byte-for-byte
-- untouched and the repair lands here instead.
--
-- VERSION 1 IS NEVER REWRITTEN. The bootstrap backfilled an acceptance row for
-- every user who had already accepted the legacy terms, and those rows point at
-- version 1 by id. Editing that body in place would leave the audit trail
-- claiming those users accepted wording they never saw. So a body that needs
-- repair makes version 1 ARCHIVED — history and its acceptances intact — and
-- the corrected text is PUBLISHED as a new version that users accept afresh.
--
-- ZWNJ (U+200C) and ZWJ (U+200D) are deliberately NOT stripped: they are
-- ordinary letters in Persian.
--
-- Scope is narrow by design: only the still-PUBLISHED version 1 written by the
-- bootstrap (no admin author on either side) is considered. An archived version
-- 1 is history, and any version an operator published through the bot was
-- already normalized on the way in.

DO $$
DECLARE
    bootstrapped RECORD;
    normalized TEXT;
    next_version INTEGER;
BEGIN
    IF to_regclass('"TermsDocument"') IS NULL THEN
        RETURN;
    END IF;

    SELECT "id", "body" INTO bootstrapped
    FROM "TermsDocument"
    WHERE "version" = 1
      AND "status" = 'PUBLISHED'
      AND "createdByAdminId" IS NULL
      AND "publishedByAdminId" IS NULL
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    normalized := btrim(
        regexp_replace(
            translate(
                bootstrapped.body,
                U&'\200B\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069\FEFF',
                ''
            ),
            U&'[\0001-\0008\000B-\001F\007F-\009F]', '', 'g'
        )
    );

    IF normalized = bootstrapped.body THEN
        -- Already clean and within limits: nothing to repair, nobody disturbed.
        RETURN;
    END IF;

    -- Archive version 1 either way. The partial unique index permits only one
    -- PUBLISHED row, so this must happen before anything new is published.
    UPDATE "TermsDocument"
    SET "status" = 'ARCHIVED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = bootstrapped.id;

    -- "Meaningful" must match the application's test, which ignores ALL
    -- whitespace. One-argument btrim only strips SPACES, so a body of, say, a
    -- bidi override wrapped in tabs and newlines would survive as whitespace
    -- and be published as an effectively blank screen.
    IF regexp_replace(normalized, '[[:space:]]', '', 'g') = '' THEN
        RAISE NOTICE 'Versioned terms: bootstrapped version 1 held no meaningful content once normalized; archived and nothing published.';
        RETURN;
    END IF;

    -- Refuse to publish text this migration had to CUT. Truncating terms of
    -- service and then requiring acceptance of the remainder would drop real
    -- clauses; leaving nothing published is the honest outcome. The gate treats
    -- "enforcement on with nothing published" as a misconfiguration, steps
    -- aside and alerts the OWNER, so no user is locked out meanwhile.
    IF length(normalized) > 3500 THEN
        RAISE NOTICE 'Versioned terms: bootstrapped version 1 exceeds the 3500-character limit; archived and nothing published - publish a new version from the admin panel.';
        RETURN;
    END IF;

    SELECT coalesce(max("version"), 1) + 1 INTO next_version FROM "TermsDocument";

    INSERT INTO "TermsDocument" (
        "id", "version", "body", "status", "contentHash",
        "createdByAdminId", "publishedByAdminId",
        "createdAt", "updatedAt", "publishedAt"
    ) VALUES (
        gen_random_uuid()::TEXT, next_version, normalized, 'PUBLISHED',
        encode(sha256(convert_to(normalized, 'UTF8')), 'hex'),
        NULL, NULL,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    RAISE NOTICE 'Versioned terms: archived the unnormalized version 1 and published version % with the cleaned text.', next_version;
END
$$;
