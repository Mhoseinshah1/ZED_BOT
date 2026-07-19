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
