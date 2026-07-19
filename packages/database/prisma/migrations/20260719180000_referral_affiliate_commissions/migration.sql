-- Referral affiliate commissions (Phase 1) — enable a real wallet payout to the
-- referrer when a referred user completes a qualifying purchase.
--
-- Purely additive: a REVERSED status for a clawed-back commission, two nullable
-- columns (the reversal wallet-transaction id + reversal timestamp), and a UNIQUE
-- index on the source order id so a re-fired order-completion hook or a concurrent
-- settlement can never pay a commission twice. The ReferralCommission table has
-- never been written (commission crediting did not exist before this change), so
-- the unique index cannot conflict with existing data and nothing is backfilled.

-- Preflight (idempotent): BEFORE creating the UNIQUE index, fail loudly with an
-- actionable message if a legacy database somehow already accumulated duplicate
-- non-null orderId commission rows — otherwise CREATE UNIQUE INDEX below would
-- abort with PostgreSQL's opaque "could not create unique index" error. On the
-- fresh/clean table this is a no-op. (A later standalone guard migration re-asserts
-- the same invariant, but the check must run HERE, before the index is created.)
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

-- AlterEnum
ALTER TYPE "ReferralCommissionStatus" ADD VALUE 'REVERSED';

-- DropIndex (replaced by the UNIQUE index below)
DROP INDEX "ReferralCommission_orderId_idx";

-- AlterTable
ALTER TABLE "ReferralCommission" ADD COLUMN     "reversalWalletTransactionId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId");
