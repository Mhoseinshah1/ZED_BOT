-- Type-filtered reconciliation queue (§1): the admin UI lists ONE
-- FinancialReconciliationType at a time (duplicate-success vs. service-username
-- reconciliation) with type-specific counts and pagination. This composite index
-- serves the newest-first, type-filtered query. Forward-only, additive, and
-- concurrency-safe to create; CREATE INDEX IF NOT EXISTS is idempotent.
CREATE INDEX IF NOT EXISTS "FinancialReconciliationCase_type_createdAt_idx"
  ON "FinancialReconciliationCase" ("type", "createdAt");
