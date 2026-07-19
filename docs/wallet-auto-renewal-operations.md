# Wallet Auto-Renewal — Operations Runbook

Operational guide for the consent-based wallet auto-renewal system
(see `docs/wallet-auto-renewal.md` for the architecture).

## Enabling the system

The system is **disabled by default**. To enable:

1. Ensure the **worker** process is running and reporting its heartbeat (the
   admin page's activation gate refuses to enable while the worker is silent —
   otherwise nothing would scan or execute).
2. Ensure **wallet payment** is enabled (`wallet_payment_enabled`) — the wallet
   settlement is gated on it (an in‑flight execute returns `wallet-disabled` and
   retries later while it is off).
3. OWNER → **تنظیمات عمومی ⚙️ → تمدید خودکار 🔁 → فعال‌سازی سامانه ✅**.

Once enabled, the worker's settings‑driven scheduler installs the recurring
`SCAN` / `RECONCILE` / `CLEANUP` jobs. Disabling removes all recurring jobs and
makes every in‑flight execute a dormant no‑op — **disabling is always allowed
and never gated**.

## What runs where

- **Worker** (`service-auto-renewal` queue): `SCAN` every
  `wallet_auto_renewal_scan_minutes`; `RECONCILE` every 5 min (re‑arms orphaned
  attempts, cancels stale‑cycle attempts); `CLEANUP` daily (prunes terminal
  attempts past `wallet_auto_renewal_attempt_retention_days`).
- **Bot** (`service-auto-renewal-execute` queue): the EXECUTE consumer runs the
  wallet charge + in‑place renewal. It is the bot's first BullMQ consumer and
  shuts down gracefully with the bot.

## Heartbeat / health

Auto‑renewal counts + last‑scan time are merged into the shared
`NotificationWorkerStatus` snapshot (counts and timestamps only — never a user
id, service id, order id or balance). The admin page reads authoritative counts
directly from the DB (active/paused/cancelled mandates; open/completed/
insufficient/requires‑action/failed attempts).

## Manual controls (OWNER)

- **Dry‑run preview** — read‑only list of mandates already inside the charge‑lead
  window (what the next scan would pick up). Never charges.
- **Manual scan** — enqueues one `SCAN` job (deduped). No‑ops while disabled.
- **Paused‑mandate review** — inspect why a mandate paused and admin‑pause or
  admin‑cancel it. Admins can never enable or raise authorization.

## Failure modes & what happens

| Situation | Outcome |
| --- | --- |
| Live price > user ceiling | Mandate paused `PRICE_ABOVE_LIMIT`, **no charge**, user notified. Re‑consent with a higher ceiling to resume. |
| Insufficient wallet balance | Bounded retries (`[0,360,1440]` min, cap 3), then pause `INSUFFICIENT_BALANCE`. **No** deduction. |
| Product/panel unavailable | Pause `PRODUCT_UNAVAILABLE` / `PANEL_UNAVAILABLE`. |
| Stale Service state | Worker enqueues a priority sync and defers — **never charges on stale state**. |
| Manual renewal moved the expiry | Attempt cancelled (`cycle-changed`) — no double charge. |
| Panel renewal fails definitively | Wallet **refunded** via the existing path; mandate paused `FULFILLMENT_REVIEW`. |
| Panel outcome uncertain (timeout) | Order stays `PAID`; the **startup reconciler** completes or refunds on proof. We never refund on uncertainty. |
| Worker restart mid‑flight | Reconcile re‑arms the attempt; the execute re‑runs idempotently (same mandate+cycle key). |

## Rotating consent (`wallet_auto_renewal_consent_version`)

Bumping this setting invalidates existing consent for **resume**: a paused
mandate on an old version cannot be resumed and the user is asked to re‑consent.
Existing ACTIVE mandates keep working on their stored version until they pause.

## Security notes

- Callbacks and queue payloads carry only **short ids / attempt ids** — never
  full ids, balances, or secrets.
- Every Telegram send is best‑effort; a delivery failure never rolls back a
  completed renewal or a wallet deduction.
- The wallet deduction is an atomic conditional update — a negative balance is
  impossible, and a double click / retry / restart deducts at most once per
  cycle via the idempotency key.

## Pre-charge notice operations (Corrective Phase)

- **Setting:** `wallet_auto_renewal_precharge_notice_minutes` (default 1440). `0`
  disables ONLY the advance notice — renewal/insufficient/success/price-change
  messages still send. Edit it from the WAR admin page → «اعلان پیش از کسر»
  (presets ۶/۱۲/۲۴/۴۸ ساعت + غیرفعال, or a custom minute value; OWNER-only).
- **Dry-run / test send:** the admin page previews the notices the next scan would
  schedule (creates nothing) and can send a rendered sample to the admin (no row,
  no money).
- **Heartbeat:** `walletPrechargeScheduledCount`, `walletPrechargeCatchUpCount`,
  `walletPrechargeSentCount`, `walletPrechargeFailedCount`,
  `walletPrechargeExpiredCount`, `lastWalletPrechargeScheduleAt`.
- **SystemLog events:** `wallet_auto_renewal.precharge_scheduled` / `_catch_up` /
  `_cancelled` / `_expired` / `_delivery_unconfirmed` / `_setting_changed` (PII-free).
- **Reason codes:** `precharge-window-missed` (charge proceeded, no advance window),
  `precharge-delivery-unconfirmed` (Telegram outage past the bounded wait → charge
  proceeded), `auto-renewal-cycle-changed` / `auto-renewal-charge-window-passed`
  (notice cancelled/expired at delivery). See
  [wallet-auto-renewal-precharge-notices.md](./wallet-auto-renewal-precharge-notices.md).
