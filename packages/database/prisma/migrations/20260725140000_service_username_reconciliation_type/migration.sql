-- Durable reconciliation for a paid SERVICE order whose exact username
-- reservation could not be bound at an external-success settlement (receipt /
-- gateway / one-shot Stars). Forward-only, additive: one new enum value. The
-- settlement files a FinancialReconciliationCase of this type, preserves provider
-- SUCCESS truth, and does NOT dispatch the order to provisioning until an
-- operator resolves it. The case never carries a raw username or note.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent and does not rewrite existing rows.
ALTER TYPE "FinancialReconciliationType" ADD VALUE IF NOT EXISTS 'SERVICE_USERNAME_UNBOUND';
