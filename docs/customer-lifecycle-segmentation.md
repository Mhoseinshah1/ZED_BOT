# Customer Lifecycle Segmentation (Phase 3)

The win-back engine classifies every candidate into exactly one lifecycle segment
using a single pure resolver in `@zedbot/shared`
(`resolveCustomerLifecycleSegment` in `winback.ts`). The worker scan, the delivery
re-validation and the admin dry-run preview all call the SAME resolver, so a
customer's segment can never diverge between "what the preview counted" and "what
the scan scheduled".

The segment is **derived from authoritative live rows on every evaluation** — it
is never persisted. There is no stored "customer value score" or cached segment
to drift out of date.

## The lifecycle snapshot

`CustomerLifecycleSnapshot` (built by the worker from batch-loaded rows) is the
only input to the resolver, plus the validated `WinbackConfig` and the current
time. It carries no secret and no raw identifier beyond the anchoring order id
(used only to compute the hashed lapse-cycle fingerprint):

| Field | Source of truth |
|-------|-----------------|
| `userStatus`, `userGroup` | `User.status`, `User.group` |
| `cronNotificationsEnabled`, `marketingMessagesEnabled` | `User` preference booleans |
| `completedPaidServiceOrderCount` | count of `Order` type `SERVICE_PURCHASE`, status `COMPLETED`, `finalPriceToman > 0` |
| `lifetimePaidServiceSpendToman` | sum of `finalPriceToman` over completed paid-Service-lifecycle orders |
| `hasUsablePaidService` | any PAID service classified `USABLE` |
| `hasProvisioningService` | any PAID service `CREATING` |
| `hasUncertainPaidService` | any PAID service with stale panel state |
| `latestPaidServiceEffectiveEndAt` | max effective-end across LAPSED paid services |
| `latestCompletedPaidServiceOrderId` | the newest completed `SERVICE_PURCHASE` order id |
| `hasActiveTrial`, `hasTrialProvisioning` | `FreeTrialClaim` / `Service.source == FREE_TRIAL` |
| `hasResumableCheckout` | a PENDING, unexpired `CheckoutSession` |
| `hasPendingReceiptReview` | a `Payment` in `PENDING_REVIEW`/`PROCESSING` |
| `hasOpenFinancialReconciliation` | a `FinancialReconciliationCase` `OPEN`/`IN_REVIEW` |
| `hasUnresolvedProvisioningOrder` | an `Order` in `PENDING_REVIEW`/`PROVISIONING` |
| `winbackSnoozedUntil` | `CustomerRetentionPreference.winbackSnoozedUntil` |
| `existingCycleNotificationCount`, `sentStageDaysThisCycle` | prior `CUSTOMER_WINBACK` rows for the current lapse-cycle fingerprint |

## Segments (most-blocking first)

1. **INELIGIBLE_USER_STATUS** — `userStatus != ACTIVE`.
2. **INELIGIBLE_USER_GROUP** — `userGroup` not in `allowedUserGroups` (default only `F`; representatives `N`/`N2` require explicit opt-in).
3. **NEVER_PAID** — below the paying-customer threshold, no trial signal.
4. **TRIAL_ONLY** — below the paying-customer threshold with a live/used trial. Trial-only users receive **no** win-back in this phase (lead-nurture is out of scope).
5. **MARKETING_OPT_OUT** — a paying customer with `marketingMessagesEnabled == false`.
6. **WINBACK_SNOOZED** — `winbackSnoozedUntil` in the future.
7. **FINANCIAL_HOLD** — an open reconciliation or a pending receipt.
8. **PURCHASE_IN_PROGRESS** — a provisioning service, resumable checkout, unresolved provisioning order, or a live trial.
9. **ACTIVE_CUSTOMER** — a usable/unlimited paid service (still recoverable).
10. **SERVICE_STATE_UNCERTAIN** — the only paid-service evidence is stale panel state (see freshness, below).
11. **RECENTLY_LAPSED** — cleanly lapsed but for less than the first stage.
12. **LAPSED_STAGE_1 / 2 / 3** — cleanly lapsed past a configured stage (the coarse display label caps at 3).

Only the `LAPSED_STAGE_*` segments are win-back eligible (subject to the cron
gate, per-cycle cap and the catch-up stage selection).

## Paying-customer definition

A previous paying customer has **at least one `Order` of type `SERVICE_PURCHASE`,
status `COMPLETED`, with `finalPriceToman > 0`**, and the count/spend meet the
configured thresholds. Explicitly NOT counted: free trials, `ADMIN_CREATED`
services, `OTHER_PRODUCT`-only purchases, wallet top-ups, cancelled/failed/
refunded orders, pending receipts, and duplicate-success payments under
reconciliation. Cached `User.paidOrdersCount` is used only to narrow the scan
query; final eligibility is always the authoritative order history.

## Inactive-since (effective service end)

Inactivity is measured from the customer's **paid Service / Order history**, never
from `User.lastSeenAt` — a customer who still opens Telegram but owns no service
is lapsed, and a customer who never opens Telegram but owns an active service is
not. `latestPaidServiceEffectiveEndAt` is the maximum effective-end across the
customer's LAPSED paid services; `inactiveDays = floor((now − end) / 1 day)`.

Per-service disposition (`classifyPaidServiceForWinback`):

| Service state | Disposition | Effective end |
|---------------|-------------|---------------|
| ACTIVE/LIMITED/DISABLED, future expiry or unlimited (`expiresAt = null`) | USABLE (blocks) | — |
| CREATING | PROVISIONING (defer) | — |
| ACTIVE/LIMITED/DISABLED past expiry, **fresh** | LAPSED | `expiresAt` |
| ACTIVE/LIMITED/DISABLED past expiry, **stale** panel state | UNCERTAIN (defer + sync) | — |
| EXPIRED, **fresh** | LAPSED | `expiresAt` |
| EXPIRED, **stale** panel state | UNCERTAIN (defer + sync) | — |
| DELETED, financially settled | LAPSED | `expiresAt ?? deletedAt` |
| DELETED, unsettled / FAILED | IGNORE (no guess) | — |

See [customer-winback-rules.md](customer-winback-rules.md) for the stage,
catch-up and lapse-cycle rules, and [service-state-sync.md](service-state-sync.md)
for the freshness/priority-sync mechanics reused from Phase 1.
