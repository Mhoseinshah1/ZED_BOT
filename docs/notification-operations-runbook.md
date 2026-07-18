# Notification Engine — Operations Runbook (Phase 1)

## Enabling the engine (production)

1. Ensure the worker is deployed and its **heartbeat** is fresh (admin →
   گزارشات/بکاپ → system health) and Redis is `ok`.
2. Admin panel → **تنظیمات عمومی** → **اعلان‌ها و یادآوری‌ها 🔔**.
3. Enable the rules you want (**expiry / traffic / trial**). At least one rule
   must be on before the master switch can be enabled.
4. (Optional) tune thresholds, quiet-hours default, daily cap, timezone.
5. Toggle the **master switch on**. The activation gate verifies, in order:
   Redis reachable · worker heartbeat healthy · notification worker status fresh
   (queues registered) · ≥1 rule enabled · a live **Telegram test** to your own
   chat succeeds. If any check fails the switch stays **off** with the specific
   reason shown — fix it and retry.
6. Watch the health page: `lastServiceSyncAt` and `lastServiceScanAt` should
   advance within a couple of cadences; `deliveryWaiting` should drain.

To **disable**, toggle the master switch off (never gated). The scheduler
removes every recurring job within ≤5 minutes; in-flight deliveries finish or
are cancelled by the master-switch re-check.

## Health signals (admin page)

| Field | Healthy | Investigate when |
|-------|---------|------------------|
| Worker status | reporting, fresh `checkedAt` | key missing/stale ⇒ worker down or Redis down |
| `schedulerActive` | `true` when master on | false while master on ⇒ scheduler not reconciling |
| `lastServiceSyncAt` | within ~2× sync cadence | far behind ⇒ panels failing / breaker open |
| `lastServiceScanAt` | within ~2× scan cadence | far behind ⇒ scan job stuck |
| `deliveryWaiting` | small / draining | growing ⇒ Telegram rate-limit or delivery stuck |
| `deliveryFailed` | ~0 | rising ⇒ transient Telegram/network issues |
| `deadLetter` | ~0 | rising ⇒ permanent rejections (blocked users, bad chats) |

## Common situations

- **A panel is down** — sync trips its circuit breaker after 5 failures and
  skips it for ~10 min; traffic/status notices for that panel's services pause
  (stale-state gate) and resume automatically once the panel is healthy. Expiry
  notices continue (DB-authoritative).
- **Telegram 429 storm** — the delivery limiter (15/min) plus per-429 pauses
  throttle sends; jobs requeue without consuming attempts. `deliveryWaiting`
  rises then drains; no action needed.
- **Dead-letter growth** — inspect the admin "failed/dead-letter list". Codes:
  `forbidden` / `chat-not-found` (user blocked the bot — expected churn),
  `network-*` / `telegram-5xx` (transient — should have retried first). These
  rows are inert; cleanup prunes them after `notification_dead_letter_retention_days`.
- **Duplicate or stale notice reported** — check the row's `dedupeKey` and
  `payloadSnapshot.meta.cycle`. A renewal/extra-volume legitimately opens a new
  cycle; delivery cancels a notice whose cycle no longer matches live state.

## Maintenance jobs

- **reconcile** (every 5 min): re-arms due `SCHEDULED` rows (quiet-hours /
  daily-cap deferrals, or scan enqueues lost to a Redis flush) and rescues
  `SENDING` rows orphaned by a crash (claimed > 10 min ago) back to `SCHEDULED`.
  The delivery CAS still guarantees at-most-once send.
- **cleanup** (every 24 h): prunes terminal history past retention
  (`SENT/CANCELLED/SUPPRESSED/EXPIRED` = 90 d, `FAILED` = 30 d, `DEAD_LETTER` =
  180 d). Never touches in-flight rows.

## Dry-run audience preview

The admin page shows an estimated count of services that would currently qualify
under the enabled rules — use it before enabling to gauge send volume. It is a
read-only estimate (labeled تخمینی); it never creates or sends anything.

## Rollback

The engine is additive and disabled by default. To fully stand down: master
switch off (stops all recurring work) — no data migration or redeploy needed.
The schema, rows, and worker code remain dormant.

## Checkout-payment reminders (Phase 2)

Enable: admin → تنظیمات عمومی → «اعلان‌ها و یادآوری‌ها 🔔» → «یادآوری سفارش ناقص
🛒» / «یادآوری پرداخت ناموفق 💳». Enable the rule (each behind the fail-safe
activation gate), tune thresholds/delay/caps, preview the audience (تخمینی), then
send a test. Both rules are OWNER-only and disabled by default; the master switch
stays authoritative.

- **Rollback**: disable the rule (or the master switch) — the checkout scheduler
  is removed within ≤5 min; scheduled reminders cancel at delivery re-validation.
  No data migration.
- **Troubleshooting**: a stuck backlog usually means Telegram rate-limiting
  (drains on its own) or a disabled worker. A reminder that never fires: check
  the rule enabled + fresh worker status + the checkout still PENDING/unsettled
  with no pending receipt. Reminders for a settled/paid checkout are impossible
  (delivery re-validates); if reported, inspect the row's `safeErrorCode`
  (checkout-settled / payment-competing-success / ...).
- **Known limitations**: the payment scan bounds itself to failures in the last
  7 days; a pure usage reset without renewal does not re-open a cycle (Phase 1);
  quiet-hours/daily-cap deferrals re-arm on the reconcile cadence (≤5 min).

## Customer win-back (Phase 3)

Enable: admin → تنظیمات عمومی → «اعلان‌ها و یادآوری‌ها 🔔» → «بازگرداندن مشتریان
غیرفعال 👋». Tune the config (stages/groups/thresholds/snooze/max), preview the
audience (تخمینی), send a test, then toggle on behind the fail-safe activation
gate (master · Redis · heartbeat · fresh status · retention scheduler · template ·
config · ≥1 group). OWNER-only; disabled by default. Full detail (health signals,
safe log events, user controls, rollback, limitations, Phase 4) lives in
[customer-winback-operations.md](customer-winback-operations.md).

- **Rollback**: disable the rule (or the master switch) — the retention scheduler
  is removed within ≤5 min; scheduled reminders cancel at delivery re-validation.
  No data migration.
- **Troubleshooting**: a reminder that never fires — check the rule enabled + fresh
  worker status + the customer is a completed paying customer with no usable/
  uncertain paid service, not snoozed/opted-out, past the first stage, under the
  per-cycle cap. A reminder to someone who bought again is impossible (delivery
  cancels `winback-cycle-changed` / `winback-active-service`). A large
  `winbackExcludedUncertainService` means panels are stale/unreachable (priority
  syncs are being enqueued; nothing is guessed).

## Phase 4 — analytics & attribution

Analytics is off by default. Enable/disable, read reports (cohort vs conversion
views), export the aggregate CSV (OWNER) and trigger a manual reconcile from
`گزارشات / بکاپ 🛡 → تحلیل اعلان‌ها 📈`. Full operator guide:
[notification-analytics-operations.md](notification-analytics-operations.md);
metric formulas: [analytics-metric-definitions.md](analytics-metric-definitions.md);
attribution contract: [conversion-attribution.md](conversion-attribution.md).
