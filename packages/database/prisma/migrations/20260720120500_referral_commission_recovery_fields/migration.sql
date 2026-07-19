-- Referral financial-safety hardening (additive): no-overdraft clawback
-- accounting on ReferralCommission. When a refunded order's credit cannot be
-- fully recovered without driving the referrer's wallet negative, the recovered
-- portion is tracked here and the outstanding remainder is collected over time.
ALTER TABLE "ReferralCommission"
  ADD COLUMN IF NOT EXISTS "recoveredToman" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "recoveryOutstandingToman" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reversalRequestedAt" TIMESTAMP(3);

-- A debt can never be over-collected, go negative, or exceed the original credit.
-- (Prisma cannot express cross-column CHECKs, so this is raw SQL — a pure backstop
-- behind the row-locked recovery transaction.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReferralCommission_recovered_bounds'
  ) THEN
    ALTER TABLE "ReferralCommission"
      ADD CONSTRAINT "ReferralCommission_recovered_bounds"
      CHECK (
        "recoveredToman" >= 0
        AND "recoveredToman" <= "amountToman"
        AND "recoveryOutstandingToman" >= 0
        AND "recoveryOutstandingToman" <= "amountToman"
      );
  END IF;
END $$;
