# Customer Retention Engine — Phase Roadmap

The retention engine is a single, phased notification system. Each phase adds
rules on top of the same foundation (persistent `AutomatedNotification` records,
one delivery queue + CAS worker, quiet hours, daily limits, the `ntf:*` callback
namespace, the MessageTemplate/ButtonText registries, and one admin health
page). Every phase ships disabled by default.

## Phase 1 — Service & trial notifications (merged, PR #99)

`SERVICE_EXPIRY`, `SERVICE_TRAFFIC`, `SERVICE_EXPIRED`, `SERVICE_LIMITED`,
`TRIAL_NEAR_EXPIRY`, `TRIAL_EXPIRED`. Worker-owned panel sync + scan + delivery +
maintenance. See [notification-architecture.md](notification-architecture.md),
[service-notification-rules.md](service-notification-rules.md).

## Phase 2 — Abandoned checkout & failed payment reminders (this branch)

`ABANDONED_CHECKOUT`, `PAYMENT_RETRY` (category PAYMENT). A checkout scan on the
existing scan queue + a delivery re-validation branch. Reminders navigate users
back into an existing checkout but never settle, create orders, approve receipts,
spend wallet, provision, or alter reconciliation. See
[checkout-payment-reminders.md](checkout-payment-reminders.md),
[abandoned-checkout-rules.md](abandoned-checkout-rules.md),
[payment-retry-notifications.md](payment-retry-notifications.md).

## Phase 3 — Customer win-back (this branch, `feat/customer-winback-automation`)

`CUSTOMER_WINBACK` (category MARKETING, lowest priority). Authoritative
inactive-customer identification from paid Service/Order history, lifecycle
segmentation, multi-stage reminders with a lapse-cycle fingerprint + catch-up,
per-user snooze, the existing `marketingMessagesEnabled` permanent opt-out, fresh
service-state gating (priority sync + never-guess), and a `SCAN_RETENTION_NOTIFICATIONS`
scan on the existing scan queue. Disabled by default; targets only genuine
previous paying VPN customers who currently have no usable service. See
[customer-winback-rules.md](customer-winback-rules.md),
[customer-lifecycle-segmentation.md](customer-lifecycle-segmentation.md),
[customer-winback-operations.md](customer-winback-operations.md).

## Phase 4 — Analytics & reporting (planned, `feat/notification-analytics-reporting`)

Click reporting, evidence-based conversion attribution, date-range reporting,
aggregate retention metrics, operational dashboards.

Auto-renewal and recurring Stars subscriptions remain a separate later project;
the retention engine never charges a user automatically.

## Invariants across all phases

- Disabled by default; no notification during migration/seed/deploy/restart.
- The financial and provisioning systems stay authoritative — notifications
  observe and navigate, never mutate.
- No secret (token, authority, credential, receipt/form content, per-user price)
  enters a snapshot, queue, log, or Telegram message.
- One resolver per rule (pure, in `@zedbot/shared`) shared by the scan, the
  delivery re-validation and the admin preview.
