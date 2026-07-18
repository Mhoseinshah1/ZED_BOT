# Customer Win-Back — Operations (Phase 3)

## Enabling the campaign (production)

1. Ensure the worker is deployed, its **heartbeat** is fresh (admin →
   گزارشات/بکاپ → system health), Redis is `ok`, and service-state sync is
   healthy.
2. Admin panel → **تنظیمات عمومی** → **اعلان‌ها و یادآوری‌ها 🔔** → **بازگرداندن
   مشتریان غیرفعال 👋**.
3. Tune the config (stage days, allowed groups, min orders/spend, snooze days,
   max-per-cycle) — each edit is validated by the shared parser; an invalid value
   is rejected (never a silent reset).
4. Preview the audience (تخمینی) and inspect the exclusion breakdown; send a
   **test** to yourself.
5. Toggle the rule **on**. The activation gate verifies, in order: master switch
   on · Redis reachable · worker heartbeat fresh · notification worker status
   fresh · retention scheduler active · the `notification_customer_winback`
   template renders · config valid · ≥1 allowed group. On any failure the rule
   stays **off** with the fixed message *«امکان فعال‌سازی وجود ندارد…»*.
6. Watch the health page: `lastRetentionScanAt` should advance within ~2× the
   scan cadence (daily by default); `winbackScheduled` and `deliveryWaiting`
   reflect volume.

All config + toggle mutations are **OWNER-only**; read-only status follows the
existing admin permissions. Both the rule and the whole engine can be disabled at
any time (never gated): the retention scheduler is removed within ≤5 min and any
scheduled reminder cancels at delivery re-validation.

## Health signals (admin page)

| Field | Healthy | Investigate when |
|-------|---------|------------------|
| `lastRetentionScanAt` | within ~2× the scan cadence | far behind ⇒ rule off / scan stuck |
| `winbackCandidates` | reflects the eligible base | 0 while the preview shows many ⇒ narrowing/gate issue |
| `winbackScheduled` | small, drains via delivery | growing with a stuck `deliveryWaiting` ⇒ Telegram rate-limit |
| `winbackExcludedUncertainService` | small | large ⇒ panels stale/unreachable (syncs are being enqueued) |
| `retentionScanFailures` | 0 | rising ⇒ inspect worker logs (safe codes only) |

## Operational logging (safe events)

`notification.retention_scan.completed` / `.failed`,
`notification.winback.scheduled` / `.sent` / `.cancelled` / `.snoozed` /
`.dead_letter`, `notification.marketing_opt_out.changed`,
`notification.winback_rule.changed`. Metadata is counts / stage key / rule
version / duration / safe result code / admin id for settings changes — **never**
a user id (when avoidable), Telegram id, service username, lifetime spend, product
price, checkout/payment id, or message body.

## User controls

- **In a win-back message**: «مشاهده پلن‌ها 🔐» (opens the live storefront, creates
  no checkout), «کیف پول من 🏦» (opens the wallet, never charges), «فعلاً یادآوری
  نکن» (confirm → snooze win-back for `snoozeDays`), «عدم دریافت پیشنهادها»
  (confirm → permanent marketing opt-out).
- **Settings page** («تنظیمات اعلان‌ها 🔔» under سرویس‌های من): a marketing
  on/off toggle (the authoritative permanent opt-out on `marketingMessagesEnabled`)
  and a «لغو توقف موقت» button to clear an active snooze. Re-enabling marketing
  here is how an opted-out user opts back in.

## Common situations

- **A reminder never fires** — check: the rule enabled + fresh worker status + the
  customer is a completed paying customer + currently has no usable/uncertain paid
  service + not snoozed/opted-out + past the first stage + under the per-cycle cap.
- **A reminder to a customer who just bought again** — impossible to send: delivery
  re-validates and cancels `winback-cycle-changed` / `winback-active-service`.
- **Stale/unreachable panel** — the candidate is `SERVICE_STATE_UNCERTAIN`; a
  priority sync is enqueued and the customer waits (never marketed on a guess).
- **Opt-out / snooze reported as ignored** — both are re-checked at delivery, and
  the scan proactively suppresses pending rows; inspect the row's `safeErrorCode`
  (`winback-marketing-opt-out` / `winback-snoozed`).

## Rollback

The engine is additive and disabled by default. To stand down: toggle the rule
(or the master switch) off — the retention scheduler is removed within ≤5 min;
scheduled reminders cancel at delivery re-validation. No data migration, no
redeploy. `CustomerRetentionPreference` rows and worker code remain dormant.

## Known limitations

- Targets only genuine previous **paying VPN** customers with no usable service;
  trial-only and OTHER_PRODUCT-only customers are out of scope (lead nurture is a
  later project).
- No conversion attribution — Phase 4 owns evidence-based attribution and
  reporting. This phase makes no revenue claim and does no read/open tracking.
- No automatic discount, coupon, personalized pricing, wallet charge, renewal, or
  recurring subscription — navigation only.
- The scan runs daily by default; a just-lapsed customer is first considered on
  the next scan after crossing the first stage.

## Phase 4 (planned)

Click/'conversion' attribution with evidence, date-range reporting, aggregate
retention/campaign metrics, and operational dashboards — building on the same
`AutomatedNotification` + `NotificationInteraction` history this phase records.
