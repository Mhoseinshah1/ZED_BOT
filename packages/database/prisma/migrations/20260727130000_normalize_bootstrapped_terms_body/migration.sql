-- Forward-only repair for 20260727120000_versioned_mandatory_terms.
--
-- That migration bootstrapped version 1 from the legacy `terms_text` template
-- VERBATIM. The application normalizes a terms body before storing it (bidi
-- overrides, direction marks, isolates, zero-width space and BOM removed, plus
-- C0/C1 control characters) and bounds it to the same 3,500-character limit the
-- admin UI enforces. A legacy template carrying any of those would therefore
-- have been published as a version 1 the admin UI itself could never produce,
-- and a 4,000-character one would render a terms screen past Telegram's
-- message limit.
--
-- The previous migration is already released, so it is left byte-for-byte
-- untouched and the repair lands here instead. ZWNJ (U+200C) and ZWJ (U+200D)
-- are deliberately NOT stripped - they are ordinary letters in Persian.
--
-- Scope is deliberately narrow: only the still-PUBLISHED version 1 written by
-- the bootstrap (no admin author on either side) is touched. An archived
-- version 1 is history and stays exactly as it was, and any version an operator
-- published through the bot was already normalized on the way in.
--
-- Acceptance rows are never touched. They key on the document id and its
-- version, both unchanged here, so nobody is asked to accept again.

DO $$
DECLARE
    bootstrapped RECORD;
    normalized TEXT;
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

    IF length(normalized) > 3500 THEN
        normalized := left(normalized, 3500);
        RAISE NOTICE 'Versioned terms: bootstrapped version 1 truncated to the 3500-character limit.';
    END IF;

    IF normalized = bootstrapped.body THEN
        RETURN;
    END IF;

    IF normalized = '' THEN
        -- The legacy text was nothing but invisible characters, which the
        -- bootstrap's emptiness test did not catch. Archiving keeps the row and
        -- every acceptance pointing at it while leaving NO published document,
        -- so enforcement cannot be switched on until a real version is
        -- published - the safe state, and the one the enable guard expects.
        UPDATE "TermsDocument"
        SET "status" = 'ARCHIVED',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = bootstrapped.id;
        RAISE NOTICE 'Versioned terms: bootstrapped version 1 held no meaningful content once normalized and was archived.';
        RETURN;
    END IF;

    UPDATE "TermsDocument"
    SET "body" = normalized,
        "contentHash" = encode(sha256(convert_to(normalized, 'UTF8')), 'hex'),
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = bootstrapped.id;

    RAISE NOTICE 'Versioned terms: normalized the bootstrapped version 1 body.';
END
$$;
