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
    utf16_length INTEGER;
    next_version INTEGER;
BEGIN
    IF to_regclass('"TermsDocument"') IS NULL THEN
        RETURN;
    END IF;

    -- Serialize against live publication. Deployments keep the OLD application
    -- containers serving traffic while migrations run (scripts/update.sh), so an
    -- OWNER can publish a version between this SELECT and the INSERT below —
    -- which would make max(version) stale and the insert collide with the
    -- single-PUBLISHED partial unique index, aborting the deployment. This is
    -- the same transaction-level lock every terms mutation takes; the key must
    -- stay identical to TERMS_CONFIG_LOCK in terms-document.service.ts.
    PERFORM pg_advisory_xact_lock(hashtext('zedbot-terms-config'));

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

    -- Mirror normalizeTermsBody exactly, in its order: fold CRLF and lone CR to
    -- LF FIRST, because the control-character sweep below would otherwise delete
    -- a lone CR outright and run two clauses together ("A\rB" -> "AB").
    normalized := regexp_replace(
        regexp_replace(
            regexp_replace(
                translate(
                    regexp_replace(bootstrapped.body, E'\r\n?', E'\n', 'g'),
                    U&'\200B\200E\200F\202A\202B\202C\202D\202E\2066\2067\2068\2069\FEFF',
                    ''
                ),
                U&'[\0001-\0008\000B-\001F\007F-\009F]', '', 'g'
            ),
            '^[[:space:]]+', ''
        ),
        '[[:space:]]+$', ''
    );

    -- The application measures its 3,500 limit with JavaScript `.length`, i.e.
    -- UTF-16 code units, while PostgreSQL length() counts code points. They
    -- diverge on astral characters (emoji): 2,100 emoji are 2,100 here but 4,200
    -- to the bot, which would then refuse to render the document at all. Count
    -- the same units the application does — each astral code point is two.
    utf16_length := length(normalized) + coalesce((
        SELECT count(*)
        FROM regexp_split_to_table(normalized, '') AS ch
        WHERE ascii(ch) > 65535
    ), 0);

    -- Nothing to repair ONLY if the body is both unchanged AND renderable. An
    -- already-clean but over-limit body must still fall through: leaving it
    -- published would gate every user behind a screen that (correctly) refuses
    -- to offer acceptance of a document it cannot show in full.
    IF normalized = bootstrapped.body AND utf16_length <= 3500 THEN
        RETURN;
    END IF;

    -- Archive version 1 either way. The partial unique index permits only one
    -- PUBLISHED row, so this must happen before anything new is published.
    UPDATE "TermsDocument"
    SET "status" = 'ARCHIVED',
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = bootstrapped.id;

    -- "Meaningful" must match isMeaningfulTermsBody, which ignores all
    -- whitespace AND the joiners. ZWNJ/ZWJ are kept inside real Persian text but
    -- a body of nothing else is blank: an RLO followed by a ZWNJ passes the
    -- original bootstrap (the RLO counts), and once the RLO is stripped only the
    -- invisible joiner is left.
    IF regexp_replace(
           translate(normalized, U&'\200C\200D', ''),
           '[[:space:]]', '', 'g'
       ) = '' THEN
        RAISE NOTICE 'Versioned terms: bootstrapped version 1 held no meaningful content once normalized; archived and nothing published.';
        RETURN;
    END IF;

    -- Refuse to publish text this migration had to CUT. Truncating terms of
    -- service and then requiring acceptance of the remainder would drop real
    -- clauses; leaving nothing published is the honest outcome. The gate treats
    -- "enforcement on with nothing published" as a misconfiguration, steps
    -- aside and alerts the OWNER, so no user is locked out meanwhile.
    IF utf16_length > 3500 THEN
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
