-- Referral idempotency safety (additive): assert the one-commission-per-order
-- invariant is holdable BEFORE (re-)enforcing the unique index. On a legacy
-- database that predates the unique index and already accumulated duplicate
-- commission rows for the same order, this FAILS LOUDLY with an actionable
-- message instead of letting CREATE UNIQUE INDEX abort with an opaque error — or,
-- worse, a later code path silently double-crediting. It never moves money,
-- deletes rows, or claims the table was unused.
DO $$
DECLARE
  dup_groups integer;
  dup_rows integer;
BEGIN
  SELECT count(*), COALESCE(sum(c), 0) INTO dup_groups, dup_rows
  FROM (
    SELECT "orderId", count(*) AS c
    FROM "ReferralCommission"
    WHERE "orderId" IS NOT NULL
    GROUP BY "orderId"
    HAVING count(*) > 1
  ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'ReferralCommission has % order id(s) carrying duplicate commission rows (% rows total). A referral payout must be at most one per order. Resolve the duplicates (keep the earliest PAID row per orderId and reconcile the wallet ledger for any extra credit) before enforcing uniqueness.',
      dup_groups, dup_rows;
  END IF;
END $$;

-- Idempotently (re-)assert the one-commission-per-order unique index. A no-op
-- where the prior migration already created it; a safety net for any database
-- that somehow lost it. NULL orderIds (none exist — the column is NOT NULL) would
-- be excluded by the unique index's standard NULL semantics regardless.
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_orderId_key"
  ON "ReferralCommission" ("orderId");
