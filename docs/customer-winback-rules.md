# Customer Win-Back Rules (Phase 3)

`CUSTOMER_WINBACK` is a **MARKETING** notification (the lowest notification
priority) that re-introduces the storefront to a genuine previous paying VPN
customer who currently has **no usable paid service**. It reuses the entire
Phase 1/2 notification engine — the scan queue, the delivery worker + CAS
lifecycle, quiet hours, daily limits, the `ntf:*` callback namespace, the
MessageTemplate/ButtonText registries, the worker heartbeat and the admin health
page. No second engine, scheduler, queue or preference system is introduced.

## Disabled by default

The rule ships **off** and stays off until the OWNER explicitly enables it behind
the activation gate. No user receives a win-back message unless ALL of:

```
automated_notifications_enabled = true
AND notification_customer_winback_enabled = true
AND user.cronNotificationsEnabled = true
AND user.marketingMessagesEnabled = true
```

No migration, seed, deployment, update or restart enables it automatically.

## Settings

| Key | Type | Default |
|-----|------|---------|
| `notification_customer_winback_enabled` | BOOLEAN | `false` |
| `notification_winback_config` | JSON | see below |
| `notification_schedule_retention_scan_minutes` | NUMBER | `1440` (daily) |

`notification_winback_config` (validated by `parseWinbackConfig`; any invalid
field falls back to the whole default — an invalid config can never create an
unbounded campaign):

```json
{
  "stageDays": [30, 60, 90],
  "allowedUserGroups": ["F"],
  "minimumCompletedPaidOrders": 1,
  "minimumLifetimeSpendToman": 0,
  "snoozeDays": 30,
  "maximumNotificationsPerLapseCycle": 3,
  "serviceStateMaxAgeMinutes": 20
}
```

Validation: stage days are unique positive integers, sorted ascending, each
between 7 and 730, at most 6 of them; allowed groups are a non-empty subset of
the real `UserGroup` enum (`F`, `N`, `N2`); minimum orders 1–100; lifetime spend a
non-negative safe integer; snooze 1–365 days; max-per-cycle ≤ the stage count;
service-state age bounded. Representative groups `N`/`N2` are targeted only when
the OWNER explicitly adds them.

## Lifecycle stages & catch-up

A stage fires **once per lapse cycle**. Meaning of the defaults:

- Stage 1 — no usable paid service for ≥ 30 days
- Stage 2 — ≥ 60 days
- Stage 3 — ≥ 90 days

**Catch-up** (`selectWinbackStage`): the engine sends only the **highest currently
applicable stage that is greater than the largest stage already sent this cycle**.

- First eligibility at 30–59 days → stage 30.
- Later at 60–89 days (stage 30 already sent) → stage 60. And so on.
- An install that first enables the rule when a customer is already 200 days
  lapsed sends **only** stage 90 — never a Stage-1/2/3 burst — and never
  backfills a lower stage afterwards.

`maximumNotificationsPerLapseCycle` caps the total notices per cycle.

## Lapse-cycle fingerprint & dedupe

A customer can lapse, return, buy again, and lapse again. The dedupe must allow a
new campaign after a genuine return.

`buildCustomerLapseCycleFingerprint` = `sha256(latestCompletedPaidServiceOrderId +
"|" + latestPaidServiceEffectiveEndAt.epoch)`, truncated to 16 hex chars. A new
completed paid purchase (new order id) or a renewal (later effective end) yields a
**new fingerprint → a new future cycle**; the old cycle's pending notices cancel
at delivery re-validation.

`buildCustomerWinbackDedupeKey(userId, fingerprint, stageDays)` =
`user:<userId>:winback:<fingerprint>:s<stageDays>` — a unique `dedupeKey`, so
concurrent scans converge on exactly one row per user/stage/cycle. The fingerprint
is **hashed**, so no raw order id enters the dedupe key, the payload meta or any
log.

### Guarantees

- One notification per user / stage / lapse cycle.
- Concurrent scans → exactly one row (unique `dedupeKey`).
- A returning customer receives no remaining notices from the old cycle (delivery
  cancels `winback-cycle-changed`).
- A later genuine lapse starts a new cycle.
- A renewal or new service invalidates pending old-cycle notices.

## Freshness — a negative assertion

Win-back requires proving the customer has **no** usable paid service. That is a
negative assertion, so it needs fresh data. Any paid service that could still be
active but whose panel-backed state is stale (older than
`serviceStateMaxAgeMinutes`) makes the candidate `SERVICE_STATE_UNCERTAIN`: the
scan enqueues a **priority sync** (reusing the Phase 1 `service-sync`
infrastructure — never a second implementation) and skips the candidate. A later
scan re-evaluates on fresh data. A panel being unreachable never causes a "guess"
of inactivity.

## Exclusions (defer, never lapsed)

Active/provisioning trial · resumable checkout · a `PROCESSING`/`PENDING_REVIEW`
payment · pending receipt · a settled checkout whose order is still converging ·
an `Order` in `PROVISIONING` · an open/in-review reconciliation · a
duplicate-success payment under review · a usable/unlimited paid service · an
uncertain service. The Phase 2 checkout/financial resolvers are reused where
possible; settlement truth is never re-derived.

## Conflict policy

`CUSTOMER_WINBACK` is the lowest notification priority. It never bypasses quiet
hours or the daily cap, and the existing priority system defers it behind urgent
transactional notices (service expiry/traffic, payment retry, abandoned checkout).
There is no separate per-feature rate limiter.

## Delivery re-validation

Before sending, delivery reloads live state and reuses the SAME shared resolver
(with the cycle counters zeroed, since the notice being delivered is itself in the
DB). Outcomes: a new usable service / not-a-paying-customer / financial /
purchase-in-progress → **CANCELLED**; marketing opt-out or snooze → **SUPPRESSED**;
a changed lapse cycle → **CANCELLED** (`winback-cycle-changed`); uncertain service
→ **deferred** and re-armed after a priority sync. A stale marketing notice is
never sent because the original snapshot still said "inactive".

## Payload safety

`payloadSnapshot` carries only `templateKey`, safe display variables
(`inactive_days`, optional `last_service_name`, `last_product_name`), the button
specs, and safe meta (`stageKey`, the hashed `cycle` fingerprint). Never a
subscription URL/token, panel data, price, lifetime spend, provider payload,
receipt content, Telegram id or full user/order id. Queue jobs carry only the
`notificationId`.

See also [customer-lifecycle-segmentation.md](customer-lifecycle-segmentation.md)
and [customer-winback-operations.md](customer-winback-operations.md).
