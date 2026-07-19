# Analytics — Precise Metric Definitions (Phase 4)

Every figure in the analytics reports is a **count** or a **sum of
`Order.finalPriceToman`** over recorded rows. There are no estimated, modelled or
inferred metrics. The definitions below are fixed in
`calculateFunnelMetrics` (`@zedbot/shared/attribution.ts`) and computed by
DB aggregation in `analytics-report.service.ts`.

## Delivery funnel

| Metric | Exact definition |
|--------|------------------|
| **Generated** | `count(AutomatedNotification WHERE createdAt ∈ [start, end))` |
| **Sent** | `count(WHERE status = SENT AND sentAt ∈ [start, end))` — a message counts as sent **only** when `status = SENT` **and** `sentAt IS NOT NULL`. This is the strongest available delivery fact; it is **not** an open, read or impression. |
| **Failed** | `count(WHERE status = FAILED AND failedAt ∈ [start, end))` |
| **Dead-letter** | `count(WHERE status = DEAD_LETTER AND updatedAt ∈ [start, end))` |
| **Delivery success rate** | `Sent ÷ (Sent + Failed + Dead-letter)`; `0` when the denominator is `0` |
| **Sent-with-interaction** | `count(SENT notifications in window with ≥ 1 NotificationInteraction)` — **unique notifications**, not clicks |
| **Click-through rate (CTR)** | `Sent-with-interaction ÷ Sent`; `0` when `Sent = 0`. Per-notification, deduplicated — a notification with three clicks counts once. |

## Conversions

A **conversion** is one `NotificationConversionAttribution` row (see
[conversion-attribution.md](conversion-attribution.md)). It always corresponds to
a completed paid Order backed by a recorded click.

| Metric | Definition |
|--------|-----------|
| **Direct checkout conversions** | attributions of kind `DIRECT_CHECKOUT` in the window |
| **Direct service conversions** | kind `DIRECT_SERVICE` |
| **Assisted win-back conversions** | kind `ASSISTED_WINBACK` |
| **Direct conversions** | `DIRECT_CHECKOUT + DIRECT_SERVICE` |
| **Total conversions** | `direct + assisted` |
| **Conversion rate** | `Total conversions ÷ Sent`; `0` when `Sent = 0` |

The "window" for conversions is the **selected view's anchor**: `notificationSentAt`
(cohort) or `orderCompletedAt` (conversion timeline).

## Revenue (attributed, never profit)

| Metric | Definition |
|--------|-----------|
| **Attributed gross revenue** | `Σ grossRevenueToman` over attributions in the window — each equal to the Order's `finalPriceToman` at attribution time |
| **Reversed revenue** | `Σ reversedRevenueToman` over `REVERSED` attributions — gross moved out on refund |
| **Attributed net revenue** | `max(0, gross − reversed)` |

Net is **attributed revenue**, not profit — no cost of goods, gateway fee, tax or
discount economics is modelled. A refunded conversion keeps its gross figure but
its net drops to zero (revenue is not double-lost and not silently deleted).

## Views

| View | Anchor | Question answered |
|------|--------|-------------------|
| **Cohort** (default) | `notificationSentAt` | "of the messages sent in this window, how many converted / for how much" |
| **Conversion timeline** | `orderCompletedAt` | "revenue booked in this window, whenever the message was sent" |

## Date ranges

All ranges are **half-open `[startInclusive, endExclusive)`**, resolved to the
allowlisted reporting timezone (default `Asia/Tehran`) via
`resolveReportDateRange`. `endExclusive` is local midnight **after** the inclusive
end day. Ranges are bounded to `MAX_REPORT_RANGE_DAYS = 366`; a malformed,
inverted or over-long range is rejected (`invalid-range`) and never runs an
unbounded query.
