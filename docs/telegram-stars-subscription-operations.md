# Telegram Stars Subscription — Operations Runbook

## Enabling (disabled by default)

BOTH switches are required:

1. The one-time Stars gateway: env `TELEGRAM_STARS_ENABLED=true` **and** an active
   `PaymentGateway` row of type `TELEGRAM_STARS`.
2. `telegram_stars_subscriptions_enabled` (the Phase-2 master switch).

OWNER → **تنظیمات عمومی ⚙️ → اشتراک‌های ماهانه Stars ⭐ → فعال کردن سیستم ✅**. The
activation gate requires the one-time gateway enabled, a live worker heartbeat and
at least one eligible 30-day subscription-enabled Product. **Disabling is always
allowed.**

## Products

A Product is subscription-eligible only when: SERVICE_PRODUCT, active, category
active, panel active + provisioning-ready, `durationDays = 30`, an explicit Stars
price in `1..10000`, `telegramStarsSubscriptionEnabled = true`, a valid renewal
plan on the Service's panel, visible to the group. The Stars price is the
**fixed** recurring contract — never derived from the Toman/Star rate. A material
change bumps `telegramStarsSubscriptionVersion`; active subscriptions keep their
frozen version until the user re-consents.

## Settings (all bounded/clamped, master default false)

`telegram_stars_subscriptions_enabled`, `..._grace_minutes` (180),
`..._reconcile_minutes` (15), `..._transaction_lookback_hours` (72),
`..._refund_max_attempts` (5), `..._pending_enrollment_minutes` (60),
`..._charge_retention_days` (730), `..._consent_version` (1).

## Admin controls

The OWNER admin page shows global status, both switches, worker heartbeat,
eligible-product count and subscription/charge counts (active / pending /
cancel-at-period-end / past-due / requires-action / refund-pending). Admins may
toggle the master switch only — never create consent, activate a subscription,
re-enable billing without user action, change an active subscription's Stars
price, or fabricate a charge.

## Cancellation & the paid period

User cancellation calls `editUserStarSubscription(..., true)` FIRST; only on
Telegram success is the subscription marked `CANCEL_AT_PERIOD_END`. The current
paid period stays active (no refund). The service is never shown as immediately
expired.

---

## Phase 2.1 — recovery, reactivation, product config & dashboard

Phase 2.1 (`feat/stars-subscription-recovery-operations`) completes the
operational scope. The worker recovery/engine and the Bot API 10.2 Update handling
are documented in `telegram-stars-subscription-recovery.md`; `/paysupport` in
`-support.md`; the financial report in `-reporting.md`. Operator-facing additions:

### New settings (code-defaulted, bounded, not seeded — no migration to tune)

`telegram_stars_subscription_max_pages_per_run` (10),
`..._transaction_page_size` (100), `..._refund_retry_minutes` (30),
`..._cursor_stale_minutes` (120) — alongside the existing Phase 2 keys.

### Reactivation (Part N)

User callbacks `user:sub:react:<short>` (confirm) + `:yes` (execute) on the gated
user composer, plus a button on the subscription detail shown **only** when
`telegramExtensionCanceled` AND a reactivation-compatible state AND a first charge
id exists. It calls the existing `reactivateTelegramExtension`
(`editUserStarSubscription is_canceled=false`) **FIRST**, then sets
`REACTIVATION_ALLOWED` + `telegramExtensionCanceled=false` + `reactivationRequestedAt`.
It **blocks** on a wallet-mandate conflict / missing service / open
refund/reconciliation, and version drift blocks incompatible reactivation. It
creates **no** Payment / Checkout / Order and shows «اجازه فعال‌سازی مجدد ثبت شد» —
**never** «تمدید شد».

### Product configuration (Part O)

`admin:starsprod:*` — a per-Product page (status / price / duration / version /
active-count / version-drift-count). **Enable** is behind the sellability gate
(`SERVICE_PRODUCT` + 30-day + price `1..10000` + active category +
assigned/active/provisioning-ready panel). **Disable** does **not** refund or
cancel active subscriptions. A **version bump** is transactional and emits **one
durable `PRICE_VERSION_CHANGED` notification per active subscription**. Existing
subscriptions keep their **frozen** contract; version drift appears in reports and
blocks incompatible reactivation. Price is set via a self-gating admin text flow.

### Admin dashboard + manual reconcile (Parts P/Q)

`admin:starsub:*` (all **OWNER-only**) — global status; gateway / worker / cursor
health; all subscription and charge counts; last reconcile. Buttons:
«اجرای تطبیق اکنون» (enqueues the 3 reconcile jobs with fixed job ids, returns
immediately — **never scans Telegram in the callback**), «محصولات اشتراکی»,
«گزارش مالی» (`-reporting.md`), «وضعیت صف و Worker». Admin powers remain bounded:
never create consent, activate a subscription, re-enable billing without user
action, change an active subscription's Stars price, or fabricate a charge.

### Lifecycle notifications (Parts R/S)

7 durable `AutomatedNotification` types (category PAYMENT), created at each
lifecycle transition and delivered by the existing worker delivery pipeline
(quiet-hours / daily-cap / retry / dead-letter):
`STARS_SUBSCRIPTION_{ACTIVATED,RENEWED,CANCELLED,PAST_DUE,REQUIRES_ACTION,REFUNDED,PRICE_VERSION_CHANGED}`.
Deduped on a safe key; payload snapshots carry **only** safe display vars + the
subscription **short** id (never a charge id / payload / UUID). Delivery
**revalidates** live Stars state — e.g. a stale `PAST_DUE` / `REQUIRES_ACTION`
notice is cancelled once the subscription has recovered to `ACTIVE`. Safe short
action buttons: view subscription `u` / view service `s` / reactivate `a` /
payment support `y`.

### Operational logging (Part Z)

Bot-side `SystemLog` events (`stars_subscription.subscription_update_received` /
`refund_update_received` / `reactivation_requested` / `reactivated`, etc.) record
**counts / state / safe codes only** — never a user / telegram / charge id,
payload, service username, Payment/Order id, or raw Telegram response. Worker-side
events use the worker's structured logger + ops-log (since `writeSystemLog` is
bot-side).

### Rollback

Disabling `telegram_stars_subscriptions_enabled` is **always allowed**: the worker
engine removes **all** schedulers, in-flight execute jobs become dormant no-ops,
and **history is preserved** (nothing deleted or refunded). Re-enabling resumes
from the persisted cursor with no re-settlement.

### Known limitations

Bot-created notifications are delivered by the worker's maintenance reconciler
(small delay); the dashboard implements the core subpages rather than every listed
one; the `Update.subscription` compat shim is removed when `@grammyjs/types`
exposes Bot API 10.2.
