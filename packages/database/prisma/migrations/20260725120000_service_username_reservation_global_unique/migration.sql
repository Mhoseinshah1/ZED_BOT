-- Service username reservation: GLOBAL active-username uniqueness (hotfix
-- fix/service-username-reservation-safety). The original feature constrained an
-- active reservation only by (panelId, activeUsernameKey), but Service.username
-- is GLOBALLY unique — so two panels could both hold an active reservation for
-- the same username and race into a provisioning collision. This migration
-- replaces the composite unique index with a GLOBAL unique index on
-- activeUsernameKey so an active hold blocks that username everywhere.
--
-- Forward-only and non-destructive: it alters NO username, deletes NO
-- reservation, and (per Postgres NULL semantics) leaves every RELEASED/EXPIRED
-- row — which sets activeUsernameKey = NULL — unconstrained. `panelId` is kept
-- for remote availability + provisioning routing.
--
-- FAIL-CLOSED PREFLIGHT: on a database that already accumulated the same active
-- username on more than one panel, the bare CREATE UNIQUE INDEX would abort with
-- an opaque duplicate-key error that leaks the username. The DO block below
-- instead RAISES a safe, actionable message that exposes ONLY a count — never a
-- username or a user id — and points operators at the manual reconciliation
-- procedure.
--
-- MANUAL RECONCILIATION (only if this migration stops here):
--   1. Find the conflicting keys WITHOUT logging them into shared history, e.g.
--        SELECT "activeUsernameKey", count(*)
--        FROM "ServiceUsernameReservation"
--        WHERE "activeUsernameKey" IS NOT NULL
--        GROUP BY "activeUsernameKey" HAVING count(*) > 1;
--   2. For each conflicting key keep exactly ONE active reservation — prefer the
--      furthest-along status (CONSUMED > BOUND > HELD), then the earliest
--      createdAt — and move the rest to RELEASED with activeUsernameKey = NULL
--      and releasedAt = now(). Never delete a row; never rewrite a username.
--   3. Re-run the migration. It is idempotent-safe to retry.

-- Fail-closed guard (safe diagnostics: count only, no username / user id).
DO $$
DECLARE
  conflict_keys integer;
BEGIN
  SELECT count(*) INTO conflict_keys
  FROM (
    SELECT "activeUsernameKey"
    FROM "ServiceUsernameReservation"
    WHERE "activeUsernameKey" IS NOT NULL
    GROUP BY "activeUsernameKey"
    HAVING count(*) > 1
  ) dupes;

  IF conflict_keys > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce global active-username uniqueness: % username(s) are actively reserved on more than one panel. Reconcile them (keep one active reservation per username, RELEASE the rest with activeUsernameKey = NULL) before applying this migration. See the migration header for the exact, privacy-safe procedure.',
      conflict_keys
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- DropIndex (the old per-panel filtered uniqueness).
DROP INDEX IF EXISTS "ServiceUsernameReservation_panelId_activeUsernameKey_key";

-- CreateIndex (the new GLOBAL filtered uniqueness; NULLs stay distinct).
CREATE UNIQUE INDEX "ServiceUsernameReservation_activeUsernameKey_key" ON "ServiceUsernameReservation"("activeUsernameKey");
