# Notification Analytics — Operations Runbook (Phase 4)

Operator guide for the analytics & conversion-attribution subsystem. See
[notification-analytics.md](notification-analytics.md) for the feature overview and
[conversion-attribution.md](conversion-attribution.md) for the attribution contract.

## Enable analytics

`گزارشات / بکاپ 🛡 → تحلیل اعلان‌ها 📈 → تنظیمات تحلیل ⚙️ → فعال‌سازی تحلیل ✅`

Enabling is **OWNER-only** and runs an **activation gate**; enabling is refused
(with a specific Persian reason) unless **all** hold:

1. Redis is reachable,
2. the worker heartbeat is fresh (present, TTL-backed),
3. the notification-engine status snapshot is fresh (≤ 10 min old).

On success, `notification_analytics_started_at` is stamped **once**. Attribution
runs only for orders completed at/after that instant — enabling analytics does
**not** retroactively attribute historical orders.

Disabling analytics stops all sweeps and the hook, but **preserves** the start
horizon, so re-enabling continues from the original instant.

## Read a report

Overview opens on the **cohort view**, last 30 days. Use:

- **نما toggle** — switch cohort ⇄ conversion timeline.
- **۷ روز اخیر / ۳۰ روز اخیر** — quick presets.
- **بازه دلخواه 📅** — send `YYYY-MM-DD YYYY-MM-DD` (Gregorian, ≤ 366 days).

Figures: delivery funnel + delivery success rate + CTR + direct/assisted
conversions + attributed gross/reversed/net revenue + per-type breakdown. All are
counts or Toman sums — never opens/reads/impressions, never profit.

## Export CSV (OWNER only)

1. Enable the export switch: `تنظیمات تحلیل ⚙️ → فعال کردن خروجی CSV`.
2. From the overview, tap **خروجی CSV 📄**.

The CSV is aggregate-only (no user/order/notification ids), formula-injection
safe, and written to a `0600` temp file that is removed after send. If the switch
is off, export is refused.

## Manual reconcile (OWNER only)

**بروزرسانی انتساب‌ها 🔄** on the overview enqueues one batch sweep + one reversal
sweep immediately (jobId-deduped). Use it after a bulk backfill of orders, or to
verify the pipeline end-to-end. Routine operation needs no manual trigger — the
after-commit hook + the periodic sweeps keep attribution current.

## Health

The worker publishes analytics health into the notification status snapshot
(read on the admin notification page and via the worker status key):

- `analyticsEnabled`, `lastAttributionBatchAt`, `lastAttributionReversalsAt`,
- `attributionsActive`, `attributionsReversed`, `attributionReconcileFailures`.

**Healthy**: `lastAttributionBatchAt` advances within roughly the configured
reconcile cadence (default 15 min) while analytics is on; `attributionReconcileFailures`
stays flat.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Enable refused | worker down / Redis down / stale status | start the worker, check Redis, retry |
| No conversions despite sends | analytics enabled recently (no back-fill), or no clicks recorded | check `started_at`; conversions need a recorded button click before the order |
| A refunded sale still counts as net | reversal sweep hasn't run yet | wait for the 60-min sweep or tap manual reconcile |
| Revenue looks low vs. total sales | attribution only counts orders backed by a click within the window | expected — attribution is evidence-based, not total sales |
| `attributionReconcileFailures` rising | batch sweep erroring | check worker logs (`worker:notif-attribution`) |

## Tuning (advanced, no migration needed)

All code-defaulted; set the Setting row to override:

- `notification_attribution_config` — JSON windows (`directCheckoutWindowHours`,
  `directServiceWindowHours`, `assistedWinbackWindowDays`, `batchLookbackHours`).
  Invalid JSON falls back to the whole default (never an unbounded window).
- `notification_schedule_attribution_reconcile_minutes` (default 15),
  `notification_schedule_attribution_reversals_minutes` (default 60),
  `notification_attribution_retention_days` (default 730),
  `notification_analytics_reporting_timezone` (default `Asia/Tehran`, allowlisted).

## Data lifecycle

`CLEANUP_NOTIFICATION_ATTRIBUTION` (daily) prunes attributions whose order
completed past `notification_attribution_retention_days`. It is a standalone
`deleteMany` on the attribution table only — it never cascades into notification,
order or financial rows. Notification history retention (Phase 1) is unchanged and
never removes an attribution (soft references).
