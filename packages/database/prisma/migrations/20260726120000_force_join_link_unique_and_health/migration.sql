-- Mandatory channel membership / Force Join — hardening follow-up.
--
-- Forward-only and additive-in-effect. Two independent changes:
--
--  1. `normalizedLink` becomes GLOBALLY unique (public AND private). The original
--     migration enforced uniqueness only among public rows, which allowed two
--     rows to advertise the same private invite link while pointing at different
--     Telegram channels. The join target a user sees must identify exactly one
--     configuration row.
--
--  2. Bounded channel-health columns, so an active channel the bot can no longer
--     verify is retired on a threshold instead of being silently excluded from
--     gating forever.
--
-- The pre-existing 20260725190000_force_join_channels migration is NOT modified.

-- ---------------------------------------------------------------------------
-- Preflight: refuse to apply while duplicate normalized links exist.
--
-- Privacy-safe by construction: it exposes ONLY the number of duplicated groups.
-- No link, invite hash, chat id, title or row id is ever emitted — a migration
-- error surfaces in deployment logs, which are not a safe place for join
-- secrets. An operator resolves duplicates from the admin UI and re-runs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    duplicate_groups INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_groups
    FROM (
        SELECT 1
        FROM "ForceJoinChannel"
        GROUP BY "normalizedLink"
        HAVING COUNT(*) > 1
    ) AS duplicates;

    IF duplicate_groups > 0 THEN
        RAISE EXCEPTION
            'ForceJoinChannel: % duplicated normalizedLink group(s) block the global unique index. Remove the duplicate force-join channels from the admin panel and re-run the migration.',
            duplicate_groups;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Replace the public-only partial unique index with a global unique index.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "ForceJoinChannel_normalizedLink_public_key";

CREATE UNIQUE INDEX "ForceJoinChannel_normalizedLink_key" ON "ForceJoinChannel"("normalizedLink");

-- ---------------------------------------------------------------------------
-- 2. Bounded channel-health state (§4.11).
-- ---------------------------------------------------------------------------
ALTER TABLE "ForceJoinChannel"
    ADD COLUMN "healthFailureCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "healthFailureFirstAt" TIMESTAMP(3),
    ADD COLUMN "healthFailureLastAt" TIMESTAMP(3),
    ADD COLUMN "unhealthyAt" TIMESTAMP(3);
