# Wallet auto-renewal — durable pre-charge notices

This document describes the **durable advance pre-charge notification** delivered
before a wallet auto-renewal deduction (Corrective Phase). It completes the
pre-charge notification behavior deferred by the original wallet auto-renewal work
(PR #104): the best-effort "renewing now" message sent from the execution path is
replaced by a **persisted, deduplicated, revalidated, cancellable** notification
normally delivered **~24 hours before** the expected wallet charge.

The whole wallet auto-renewal system remains **disabled by default** behind
`wallet_auto_renewal_enabled`. The advance notice adds no new engine, no new queue,
and never changes wallet-settlement or Service-renewal semantics.

## What changed

- **Before:** at charge time the execute consumer sent a best-effort, non-durable
  "سرویس شما هم‌اکنون … تمدید می‌شود" message (`AUTO_RENEWAL_CHARGING_TEXT`). It was
  not persisted, not deduped, and offered no cancellation window.
- **After:** the worker scan eagerly creates ONE durable `AUTO_RENEWAL_UPCOMING`
  notification per Service expiry cycle, scheduled for `prechargeNoticeAt`. The
  existing notification reconciler delivers it. The old at-charge message was
  **removed** (see [Part O](#at-charge-message-removed)); the success / insufficient
  / price-change / plan-unavailable messages are unchanged.

## Timing contract

All timing is pure and deterministic, computed by shared helpers in
`packages/shared/src/auto-renewal.ts`:

```
expectedChargeAt  = Service.expiresAt − mandate.chargeLeadMinutes
prechargeNoticeAt = expectedChargeAt  − wallet_auto_renewal_precharge_notice_minutes
```

`resolveAutoRenewalNoticeSchedule(...)` classifies a cycle into one of four kinds:

| kind | condition | action |
| --- | --- | --- |
| `scheduled` | now < prechargeNoticeAt | create the notice with `scheduledFor = prechargeNoticeAt` |
| `catch-up` | prechargeNoticeAt ≤ now < expectedChargeAt | create with `scheduledFor = now` (truthful "renewal nears" wording) |
| `missed` | now ≥ expectedChargeAt | **no** upcoming notice; record `precharge-window-missed`, charge as before |
| `disabled` | noticeMinutes ≤ 0, or no finite expiry | no notice; the charge is unaffected |

`availableUntil` is always `expectedChargeAt`, so a notice that could not be
delivered before the deduction is **EXPIRED**, never sent after the money moved.

## The durable notification

- **Type:** `AUTO_RENEWAL_UPCOMING`, **category** `PAYMENT`.
- **Gating:** delivered only when `user.cronNotificationsEnabled AND
  user.paymentNotificationsEnabled` (never marketing).
- **Dedupe key:** `wallet-auto-renewal:<mandateId>:<expiryCycleFingerprint>:upcoming:v1`
  — one notice per cycle, not per service. A later valid cycle gets its own notice;
  a stale cycle can never re-notify.
- **Payload snapshot (safe only):** `templateKey`, `mandateShort` (8 hex),
  `serviceDisplayName` (frozen `productNameSnapshot`), `productDisplayName`,
  `currentPriceToman`, `maximumChargeToman`, `expected_charge_time`,
  `service_expiry`, and the `expiryCycleFingerprint`. **Never** the wallet balance,
  a full id, a telegram id, a service username, a URL/token, panel/order/payment
  data or credentials. Queue jobs carry only the `notificationId`.
- **Template:** `notification_wallet_auto_renewal_upcoming` (Persian), variables
  `{service_name} {product_name} {current_price} {maximum_charge}
  {expected_charge_time} {service_expiry}` — no wallet balance.
- **Buttons:** «مشاهده تنظیمات تمدید خودکار» (`e`), «غیرفعال کردن تمدید خودکار»
  (`k`), «کیف پول من» (reuses `w`). Callback data `ntf:<shortId>:<code>`.

## Scheduling (worker scan)

`apps/worker/src/auto-renewal/scan.ts` — in the **not-yet-due** branch the scan
calls `ensureAutoRenewalPrechargeNotice(...)`
(`apps/worker/src/auto-renewal/precharge-notice.ts`), which:

1. Classifies the cycle (`scheduled`/`catch-up` create; `missed`/`disabled` skip).
2. Is idempotent on the cycle dedupe key (a repeat scan is a single indexed lookup).
3. Loads the Product only when actually creating a row (for the safe price + name).
4. Cancels any SCHEDULED notice of a **superseded** cycle for the same service.
5. Persists the SCHEDULED row **before** any delivery; the notification reconciler
   delivers it at `scheduledFor`.

Notice creation is a best-effort side channel — a failure there never blocks or
delays the charge. The wallet Attempt is **not** created before `expectedChargeAt`.

## Charge-race gate (never charge before the notice; never freeze on an outage)

Before creating the financial Attempt, the scan consults
`evaluateAutoRenewalPrechargeGate(...)` on the cycle's notice status:

| notice status | decision |
| --- | --- |
| `SENT` | proceed |
| `SUPPRESSED` / `FAILED` / `DEAD_LETTER` / `EXPIRED` / `CANCELLED` | proceed under the mandate (a failed notice never blocks a consented charge) |
| `SCHEDULED` with a future `scheduledFor` | defer to `scheduledFor` (warn first) |
| `SCHEDULED` (past) / `READY` / `SENDING` | briefly defer in 5-minute steps |
| no row (window missed / disabled) | proceed (records `precharge-window-missed`) |

The bounded defer has a hard cap at `expectedChargeAt + 30min`; past it the charge
proceeds and records `precharge-delivery-unconfirmed`. A Telegram outage can never
freeze a consented renewal.

## Delivery revalidation (never a stale price/cycle; never revoke a mandate)

`apps/worker/src/notifications/delivery.ts` —
`revalidateAutoRenewalUpcomingForDelivery(...)` runs at send time against LIVE state:

- master switch off → CANCEL (`auto-renewal-disabled`)
- mandate gone / not ACTIVE / not WALLET → CANCEL
- service gone / deleted / now unlimited → CANCEL
- live cycle fingerprint ≠ snapshot cycle → CANCEL (`auto-renewal-cycle-changed`)
- now ≥ expectedChargeAt → **EXPIRE** (never notify after the money moved)
- product unavailable / live price above the ceiling → CANCEL (the charge would
  pause; the ceiling is never weakened)
- otherwise **re-render** the CURRENT price / ceiling / timestamps so the delivered
  message never shows a stale amount.

The PAYMENT-category gate + quiet-hours are the existing pipeline's; a
suppressed/failed/expired notice **never** revokes a valid mandate — the charge
path is independently guarded, not driven, by this notice.

## <a name="at-charge-message-removed"></a>At-charge message (Part O)

The former `AUTO_RENEWAL_CHARGING_TEXT` "renewing now" best-effort message was
**removed** from `apps/bot/src/services/auto-renewal.service.ts`. The durable
advance notice is now the single pre-charge warning. All post-charge outcome
messages (success, insufficient balance, price above limit, plan unavailable)
are unchanged and are **not** affected by the advance-notice setting.

## Admin (OWNER-only)

The wallet auto-renewal admin page (`admin:war:*`) gains an **"اعلان پیش از کسر"**
sub-page:

- notice counts (scheduled / sent 24h / failed / expired),
- presets ۶/۱۲/۲۴/۴۸ ساعت + «غیرفعال», plus a custom-minutes entry (accepts
  English/Persian/Arabic digits),
- a **dry-run preview** of the notices the next scan would schedule (same shared
  resolver; creates nothing, moves nothing),
- a **test send** that renders the real template to the admin (no row, no money).

## Configuration

| setting | default | meaning |
| --- | --- | --- |
| `wallet_auto_renewal_precharge_notice_minutes` | `1440` (24h) | advance-notice window; `0` disables **only** the advance notice (not renewal/insufficient/success/price-change messages) |

## Heartbeat + system logs

Worker status (`WalletAutoRenewalStatusFields`) gains
`lastWalletPrechargeScheduleAt`, `walletPrechargeScheduledCount`,
`walletPrechargeCatchUpCount`, `walletPrechargeSentCount`,
`walletPrechargeFailedCount`, `walletPrechargeExpiredCount` — counts + timestamps
only. PII-free SystemLog events (`WALLET_AUTO_RENEWAL_SYSTEM_LOG_EVENTS`):
`precharge_scheduled`, `precharge_catch_up`, `precharge_cancelled`,
`precharge_expired`, `precharge_delivery_unconfirmed`, `precharge_setting_changed`.

## Invariants

- one cycle → one upcoming notice **and** one deduction;
- a cancelled mandate → no future charge and no pending notice;
- a stale cycle → no notification and no charge;
- notification code never moves money;
- the advance notice can be disabled without affecting any other message or the
  charge itself.

## Tests

- `apps/bot/tests/auto-renewal-rules.test.ts` — pure timing/dedupe helpers.
- `apps/bot/tests/auto-renewal-precharge.test.ts` — DB-backed scan scheduling,
  charge-race gate, delivery revalidation, cancellation cascade, admin settings,
  and the concurrency/invariant scenarios (real Postgres).
