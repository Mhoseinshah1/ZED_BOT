-- Referral reversal-scan selective index (additive, safe).
--
-- The reversal scan is REFUND-driven: it looks up REFUND wallet transactions (and
-- their related order ids) to find PAID commissions that must be clawed back. A
-- composite (type, relatedOrderId) index lets PostgreSQL satisfy that lookup from
-- the index alone, so the scan's cost scales with the number of refunds rather than
-- the whole (ever-growing) PAID commission population. IF NOT EXISTS keeps it a
-- no-op on any database that already has an equivalent index.
CREATE INDEX IF NOT EXISTS "WalletTransaction_type_relatedOrderId_idx"
  ON "WalletTransaction" ("type", "relatedOrderId");
