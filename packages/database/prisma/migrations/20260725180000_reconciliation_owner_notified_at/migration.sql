-- Durable OWNER-alert delivery marker for reconciliation cases (Codex P2). A
-- crash between committing a SERVICE_USERNAME_UNBOUND case and dispatching its
-- OWNER push could permanently lose the alert; this column lets the settlement
-- sweep retry any still-unnotified OPEN/IN_REVIEW case. Forward-only, additive,
-- nullable — existing rows default to NULL (treated as "not yet notified", which
-- the bounded sweep will pick up once and mark).
ALTER TABLE "FinancialReconciliationCase"
  ADD COLUMN IF NOT EXISTS "ownerNotifiedAt" TIMESTAMP(3);
