# Evidence-Based Conversion Attribution (Phase 4)

Branch: `feat/notification-analytics-reporting` · Status: **disabled by default**

Phase 4 adds a **trustworthy** conversion-attribution layer on top of the
notification history recorded by Phases 1–3. It answers "did a notification we
sent lead to a purchase?" **only** with recorded evidence, and never fabricates a
result. This document is the authoritative contract.

## 1. The trust contract (what we never do)

The system must **never**:

- claim a message was **opened**, **read**, or **seen** — Telegram gives no such
  signal, so we never assert one. The strongest delivery fact is `status = SENT`.
- infer a conversion from **temporal proximity alone** — a persisted click
  (`NotificationInteraction`) is **required** for every attribution.
- claim the notification **caused** a purchase — we say *"direct conversion"*,
  *"assisted conversion"*, *"attributed revenue"* and *"evidence-backed
  attribution"*, never "the notification generated this sale".
- report **profit** — no cost is known here. Revenue figures are **attributed
  gross / net revenue** taken from `Order.finalPriceToman` only.
- attribute across users, before the click, after the window, or over a refunded
  order.
- back-fill history — attribution begins at the instant analytics is enabled and
  looks only forward.

## 2. The convergence authority (one order, one attribution)

`NotificationConversionAttribution` is written through two DB uniqueness
constraints that make double-counting impossible:

| Constraint | Guarantee |
|-----------|-----------|
| `orderId @unique` | one completed Order has **at most one** attribution |
| `interactionId @unique` | one recorded click backs **at most one** Order |

Two writers — the low-latency **after-commit hook** and the periodic **batch
reconciler** — both call the same pure evaluator and `create()` through these
constraints. A racing double-write surfaces as `P2002` and is resolved
idempotently by treating the order as already converged. Every reference column
(`orderId` / `notificationId` / `interactionId` / `userId`) is a **soft reference**
(indexed String, no FK), mirroring `AutomatedNotification`, so notification
retention cleanup never cascades into this financial-analytics table.

## 3. Attribution kinds

`NotificationAttributionKind` (schema enum):

| Kind | Class | Evidence required |
|------|-------|-------------------|
| `DIRECT_CHECKOUT` | direct | source is `ABANDONED_CHECKOUT` / `PAYMENT_RETRY`; click is `CONTINUE_CHECKOUT`; **the completed Order's `checkoutSessionId` equals the notification's** |
| `DIRECT_SERVICE` | direct | source is a `SERVICE_*` / `TRIAL_*` notice; click is `RENEW_SERVICE` / `BUY_EXTRA_VOLUME` / `OPEN_SERVICE`; order is `SERVICE_RENEWAL` / `EXTRA_VOLUME` / `EXTRA_TIME`; **the Order's `serviceId` equals the notification's** |
| `ASSISTED_WINBACK` | assisted | source is `CUSTOMER_WINBACK`; click is `VIEW_PRODUCTS` / `VIEW_WALLET` / `OPEN_SERVICE`; order is a new `SERVICE_PURCHASE` — **no entity link** (win-back advertises the storefront, not one service), hence *assisted* |

`DIRECT_*` require **hard entity equality**. `ASSISTED_WINBACK` has none — its
evidence is "a recorded win-back click by the same user, followed by a new
purchase inside a longer window". This is exactly why it is labelled *assisted*
and never *direct*.

## 4. The evidence chain (every kind)

For any candidate `(order, interaction)`:

```
notificationSentAt  <  interactionAt  <  orderCompletedAt      (strictly increasing)
orderCompletedAt - interactionAt  ≤  window(kind)
same user (guaranteed by loading only this user's clicks)
order is COMPLETED, not refunded
orderCompletedAt ≥ analyticsStartedAt                          (no back-fill)
```

Windows (validated config `notification_attribution_config`, code-defaults):

| Kind | Default window |
|------|----------------|
| `DIRECT_CHECKOUT` | 72 hours |
| `DIRECT_SERVICE` | 72 hours |
| `ASSISTED_WINBACK` | 14 days |

## 5. Deterministic precedence

When several clicks qualify one order, exactly one wins:

1. **kind precedence** `DIRECT_CHECKOUT > DIRECT_SERVICE > ASSISTED_WINBACK`,
2. then the **most-proximate click** (latest `interactionAt` before the order),
3. then `interactionId` for a total order.

Implemented by `rankAttributionCandidates` / `selectAttributionWinner` in the pure
`@zedbot/shared/attribution.ts` — the same function the hook, the reconciler and
the tests call, so a preview can never diverge from what is written.

## 6. Where an Order becomes attributable

An Order **never reaches `COMPLETED` at settlement** — settlement writes it `PAID`
and fulfillment flips `PAID → PROVISIONING → COMPLETED` inside each executor's own
transaction. The single unified post-commit dispatcher for live payments is
`dispatchPaidOrderFulfillment` (`apps/bot/src/services/order-fulfillment.service.ts`).

- **After-commit hook**: `dispatchPaidOrderFulfillment` enqueues
  `RECONCILE_NOTIFICATION_ATTRIBUTION { orderId }` onto the notification
  maintenance queue after a completed fulfillment — non-blocking, fail-soft,
  gated on the analytics master switch, carries only the orderId.
- **Batch reconciler** (`RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH`): the
  authoritative catch-all. Sweeps `Order WHERE status = COMPLETED AND completedAt
  in the look-back window`, newest first, excluding already-attributed orders at
  the DB level. Catches every path the hook does not — crash/startup-recovery
  completions and `OTHER_PRODUCT` admin/stock deliveries — and any hook lost to a
  Redis flush.

Both are idempotent; the `orderId @unique` constraint is the durable anchor.

## 7. Refund reversal (never profit)

A completed Order is refunded/voided in this codebase as `Order.status = FAILED`
plus a `WalletTransaction(type = REFUND, relatedOrderId)` (the `REFUNDED` enum
value is unused). The reversal reconciler
(`RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS`) is signal-driven: it looks at
recent refunding wallet transactions and recent terminal Order transitions
(bounded 7-day look-back, comfortably exceeding the 60-min cadence), then runs one
idempotent SQL update:

```
status → REVERSED,  reversedRevenueToman → grossRevenueToman,
netRevenueToman → 0,  reversedAt → now()     WHERE status = 'ACTIVE'
```

`WHERE status = 'ACTIVE'` makes a second sweep a no-op and stamps `reversedAt`
exactly once. Reversed revenue is moved out of net — reporting shows gross,
reversed and net, never a "profit" figure.

## 8. Reporting views (two labelled anchors)

- **Cohort view** (default overview): conversions anchored on
  `notificationSentAt` — "of the messages sent in this window, how many
  converted, and for how much".
- **Conversion-timeline view**: conversions anchored on `orderCompletedAt` —
  "revenue booked in this window, regardless of when the message was sent".

The delivery funnel (generated / sent / failed / dead-letter / clicked) is always
anchored on the notification's own timestamps. See
[notification-analytics.md](notification-analytics.md) and
[analytics-metric-definitions.md](analytics-metric-definitions.md).

## 9. Source map

| Concern | File |
|---------|------|
| Pure contract (enums, evaluator, precedence, funnel, date-range) | `packages/shared/src/attribution.ts` |
| Schema | `NotificationConversionAttribution` + enums, migration `20260718220000_notification_conversion_attribution` |
| Worker reconciler / reversals / cleanup | `apps/worker/src/notifications/attribution.ts` |
| Worker dispatch / scheduler / status / settings | `apps/worker/src/notifications/{engine,scheduler,status,settings}.ts` |
| After-commit hook | `apps/bot/src/services/order-fulfillment.service.ts` + `ops-queue.service.ts` |
| Reporting + CSV | `apps/bot/src/services/notification/analytics-report.service.ts` |
| Settings / activation | `apps/bot/src/services/notification/analytics-settings.service.ts` |
| Admin UI | `apps/bot/src/handlers/admin-reports-backup/analytics.handler.ts` |
