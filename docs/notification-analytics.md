# Notification Analytics & Reporting (Phase 4)

Branch: `feat/notification-analytics-reporting` · Status: **disabled by default**

Phase 4 turns the notification history recorded by Phases 1–3 into an honest
analytics surface: delivery health, unique button interactions, click-through,
evidence-based conversions and attributed gross/net revenue — with date-range and
type breakdowns and an aggregate CSV export. It adds **no** new user-facing
message and sends nothing to customers; it only reads and reports.

See also: [conversion-attribution.md](conversion-attribution.md) (the attribution
contract), [analytics-metric-definitions.md](analytics-metric-definitions.md)
(exact metric formulas), [notification-analytics-operations.md](notification-analytics-operations.md)
(operator runbook).

## 1. What it reports

- **Notification generation & delivery** — generated / sent / failed / dead-letter.
- **Telegram delivery health** — delivery success rate = `SENT ÷ (SENT+FAILED+DEAD_LETTER)`.
- **Unique button interactions & CTR** — sent notifications with ≥1 recorded click,
  divided by sent (per-notification, deduplicated).
- **Direct checkout recovery** — `DIRECT_CHECKOUT` conversions + revenue.
- **Direct service renewal / extra-volume conversions** — `DIRECT_SERVICE`.
- **Assisted win-back purchases** — `ASSISTED_WINBACK`.
- **Attributed gross / reversed / net revenue** — from `Order.finalPriceToman` only.
- **Refund/reversal effects** — reversed revenue and net.
- **Date-range & type breakdowns** — bounded, timezone-aware, per notification type.
- **Aggregated CSV export** — OWNER-only, PII-free, formula-injection safe.
- **Operational analytics health** — worker sweep freshness + active/reversed counts.

## 2. Two views

The overview defaults to the **cohort view** (anchor = when the message was sent).
A one-tap toggle switches to the **conversion-timeline view** (anchor = when the
order completed). Both are labelled on the page. See the metric-definitions doc.

## 3. Admin surface

`گزارشات / بکاپ 🛡 → تحلیل اعلان‌ها 📈` (callback `admin:analytics`, namespace
`admin:an:*`). All viewing is admin-readable; every mutation and the CSV export
are **OWNER-only**:

- **Overview** — funnel + conversions + revenue for the selected range/view.
- **View toggle** + **7-day / 30-day presets** + **custom date range** (text
  input `YYYY-MM-DD YYYY-MM-DD`, bounded to 366 days).
- **CSV export** (OWNER, gated on the export switch) — an aggregate CSV via a
  safe temp file (non-guessable name, mode `0600`, unlinked after send).
- **Analytics settings / activation** — enable/disable behind the activation gate,
  toggle CSV export.
- **Manual reconcile** (OWNER) — kicks the batch + reversal sweeps once.

## 4. Activation & the "started_at" horizon

Analytics is **off** on every install. Enabling it (OWNER, behind an activation
gate that checks Redis + a fresh worker heartbeat + a fresh engine status)
stamps `notification_analytics_started_at` **exactly once**. Attribution runs only
for orders completed **at or after** that instant — there is **no historical
back-fill**. Disabling analytics preserves the horizon, so re-enabling keeps the
original start.

## 5. Settings (8)

| Key | Default | Seeded |
|-----|---------|--------|
| `notification_analytics_enabled` | `false` | yes (boolean) |
| `notification_analytics_csv_export_enabled` | `false` | yes (boolean) |
| `notification_analytics_started_at` | — | no (stamped once at enable) |
| `notification_attribution_config` | code-default (72h/72h/14d/48h) | no |
| `notification_analytics_reporting_timezone` | `Asia/Tehran` | no |
| `notification_schedule_attribution_reconcile_minutes` | `15` | no |
| `notification_schedule_attribution_reversals_minutes` | `60` | no |
| `notification_attribution_retention_days` | `730` | no |

Only the two boolean switches are seeded; config/cadence/retention are
code-defaulted so tuning a default never needs a migration.

## 6. Worker sweeps

Three recurring maintenance jobs run **only while analytics is enabled** (plus the
per-order after-commit hook):

| Job | Default cadence | Purpose |
|-----|-----------------|---------|
| `RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH` | 15 min | catch-all over recently-completed orders |
| `RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS` | 60 min | flip refunded orders' attributions to REVERSED |
| `CLEANUP_NOTIFICATION_ATTRIBUTION` | daily | prune attributions past retention |

All are on the existing `automated-notification-maintenance` queue — no new queue,
worker, scheduler or admin page. See [worker-queues.md](worker-queues.md).

## 7. Security & privacy

- Reports contain **only aggregates** — no user id, order id, notification id,
  service name or Telegram id ever appears in a message or the CSV.
- `evidenceSnapshot` stores only safe evidence (types, kind, four timestamps,
  entity-equality booleans, window seconds) — never a price beyond the order's own
  `finalPriceToman`, never a subscription link, credential or provider payload.
- The CSV neutralises formula-injection (`= + - @` and control-char prefixes) and
  RFC-4180 quotes commas/quotes/newlines; it is written to a `0600` temp file that
  is removed after send. Export is OWNER-only and separately switchable.
- The after-commit hook carries only the orderId and is fail-soft — analytics can
  never delay or fail a payment fulfillment.
