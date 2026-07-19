-- Referral affiliate commissions (Phase 1) — enable a real wallet payout to the
-- referrer when a referred user completes a qualifying purchase.
--
-- Purely additive: a REVERSED status for a clawed-back commission, two nullable
-- columns (the reversal wallet-transaction id + reversal timestamp), and a UNIQUE
-- index on the source order id so a re-fired order-completion hook or a concurrent
-- settlement can never pay a commission twice. The ReferralCommission table has
-- never been written (commission crediting did not exist before this change), so
-- the unique index cannot conflict with existing data and nothing is backfilled.

-- AlterEnum
ALTER TYPE "ReferralCommissionStatus" ADD VALUE 'REVERSED';

-- DropIndex (replaced by the UNIQUE index below)
DROP INDEX "ReferralCommission_orderId_idx";

-- AlterTable
ALTER TABLE "ReferralCommission" ADD COLUMN     "reversalWalletTransactionId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_orderId_key" ON "ReferralCommission"("orderId");
