# Free-trial service lifecycle — paid operations and conversion

The trial-lifecycle phase makes `FREE_TRIAL` services **first-class
lifecycle citizens**: the blanket action block on trial services is
removed, every paid operation (renewal, extra volume, extra time), link
regeneration and the enable/disable toggle follow the exact same
per-action rules as paid services, and the first verified paid operation
converts the trial to a paid service exactly once.

Source of truth:
`apps/bot/src/services/user-services.service.ts`
(`resolveServiceDetailActions`),
`apps/bot/src/services/trial-conversion.service.ts`
(`markTrialConversion`),
`apps/bot/src/services/service-renewal.service.ts` /
`extra-volume.service.ts` / `extra-time.service.ts` (conversion call
sites inside the persist transactions),
`apps/bot/src/services/renewal-checkout.service.ts` (panel-scoped
plans), `apps/bot/src/services/startup-recovery.service.ts`
(reconciliation conversion), `apps/bot/src/services/order-fulfillment.service.ts`
(one-time notice) and
`apps/bot/src/handlers/user-services/service-views.ts` (labels).
Tests: `apps/bot/tests/trial-lifecycle-entitlements.test.ts` (suite A).

## Origin vs capability — the principle

`Service.source` identifies how the service was **created**
(`PAID` / `FREE_TRIAL` / `ADMIN_CREATED`) and is **immutable** — it is
deliberately NOT a capability blocker. What a user can do with a service
is decided **per action** by:

1. **panel capability** — the adapter must implement the operation
   (`panelOperationAvailable`, see `docs/panel-capabilities.md`);
2. **panel state** — the panel row must exist and be `ACTIVE` for
   mutating purchases;
3. **remote model** — `serviceSupportsGlobalLifecycle`: XUI services must
   classify as `GLOBAL_CLIENT`; legacy per-inbound XUI services hide
   every mutating action (readable only);
4. **service status** — per-action status lists (below);
5. **quota shape** — unlimited-volume services never offer extra volume
   (`volumeBytes > 0` required); never-expiring services never offer
   extra time (`expiresAt !== null` required).

Business policy (e.g. "an expired service must renew before it can be
re-enabled") already lives in the per-action eligibility checks — no
origin-based rule is needed on top.

## Per-action rules (`resolveServiceDetailActions`)

One panel read resolves every detail-page button; the click routes
re-validate on their own, so these flags only gate rendering — a stale
button still fails safely.

| Button | Capability | Extra conditions |
| --- | --- | --- |
| خاموش/روشن کردن سرویس | `toggleService` | `availableToggleAction(service, panel.status)` (existing toggle rules) |
| خرید حجم اضافه ➕ | `addVolume` | panel `ACTIVE` · status ∈ `ACTIVE`, `LIMITED` · `volumeBytes > 0` |
| خرید زمان اضافه ⏳ | `addTime` | panel `ACTIVE` · status ∈ `ACTIVE`, `EXPIRED`, `LIMITED`, `DISABLED` · `expiresAt !== null` |
| تغییر لینک اشتراک 🔄 | `regenerateSubscription` | `linkRegenerationEligibility` (existing Phase 19 rules) |
| تمدید سرویس ♻️ | `renewService` | panel `ACTIVE` · status ∈ `RENEWABLE_STATUSES` (`ACTIVE`, `EXPIRED`, `LIMITED`, `DISABLED`) |

All five additionally require `serviceSupportsGlobalLifecycle(service)`.
A `FREE_TRIAL` service flows through exactly these rules — nothing more,
nothing less.

The detail page keeps the origin visible forever
(`service-views.ts`): a `FREE_TRIAL` service renders
«نوع سرویس:\nاکانت تست رایگان» before conversion and
«نوع سرویس:\nشروع‌شده با اکانت تست» after — `source` is immutable and
only `convertedToPaidAt` switches the label.

## Package selection — panel-scoped (chosen strategy)

Trial services have `orderId NULL` and `productId NULL`, so "the
original product" does not exist for them. The chosen strategy —
**list active packages compatible with the panel** — was already how the
paid flows worked, and it covers trials unchanged:

- `renewalPlansForPanel(group, panelId)` — active `SERVICE_PRODUCT`s
  with `product.panelId === service.panelId`, active category, `ACTIVE`
  panel, visible to the user's group;
- `extraVolumePackages(group, panelId)` — same panel scope plus
  `volumeGb > 0` and `priceToman > 0`;
- `extraTimePackages(group, panelId)` — same panel scope plus
  `durationDays > 0` and `priceToman > 0`.

**Never `service.order.productId`** — the validity re-checks
(`isRenewalPlanValid`, `isExtraVolumePackageValid`,
`isExtraTimePackageValid`) compare `product.panelId === service.panelId`
and re-assert capability + remote model before payment. A trial service
therefore renews with any plan its panel sells, exactly like a paid
service on that panel.

## Expired trials, per remote state

An expired trial is renewable through the normal renewal flow
(`EXPIRED` ∈ `RENEWABLE_STATUSES`). What happens then depends on the
remote account's actual state:

| Remote state | Behavior |
| --- | --- |
| Marzban user expired | renewable — the adapter's renewal is GET → usage reset → `PUT /api/user/{username}` with the new `data_limit`, `expire` and `status: "active"`; an expired remote user comes back active with the purchased quota |
| Remote account disabled | renewable — the same PUT forces `status: "active"` (the toggle rules separately require a renewal before re-enabling an expired service, which is business policy, not a capability limit) |
| Remote account missing (404) | the adapter reports a **definite failure** («Panel account not found.») and the executor takes the standard post-payment dead end: order `FAILED` + wallet refund via `failOrderWithRefund` — never a silent charge |
| Legacy per-inbound XUI | hidden from every mutating list/button by the remote-model gate; a paid order that slipped past the pre-payment gates dead-ends into a refund with «XUI legacy» reason (never silently migrated) |

UNKNOWN panel outcomes never refund and never double-apply: the order
stays `PROVISIONING` and startup reconciliation settles it from panel
truth under the same per-service lock (see
`docs/service-operation-concurrency.md`,
`docs/panel-database-reconciliation.md`).

## Trial-to-paid conversion

The FIRST verified, COMPLETED paid operation (renewal / extra volume /
extra time) on a `FREE_TRIAL` service stamps the conversion **exactly
once**:

```
markTrialConversion(tx, service, orderId):
  UPDATE Service SET convertedToPaidAt = now, firstPaidOrderId = orderId
  WHERE id = ? AND source = 'FREE_TRIAL' AND convertedToPaidAt IS NULL
  + ServiceEventLog TRIAL_CONVERTED_TO_PAID {orderId}   (only when the CAS won)
```

- **Same transaction as the completion**: each executor calls it inside
  the persist transaction that updates the `Service` and writes the
  operation's own event anchor (`service-renewal.service.ts`,
  `extra-volume.service.ts`, `extra-time.service.ts`). A rollback rolls
  back the conversion with it.
- **CAS-exactly-once**: the `convertedToPaidAt IS NULL` guard admits one
  winner; replays, retries, concurrent operations and reconciliation can
  never mark it twice. `firstPaidOrderId` records which order won (a
  soft reference — the effective idempotency key is
  `trial-conversion:<serviceId>`).
- **Reconciliation interplay**: startup recovery's
  `completeReconciledMutation` — the path that finishes a mutation which
  reached the panel but lost its DB commit — calls `markTrialConversion`
  in the same reconciliation transaction. A reconciled APPLIED verdict
  is a verified, completed paid operation and converts too; the CAS
  makes the executor/reconciler race safe.
- **One-time user notice**: `TRIAL_CONVERTED_USER_TEXT`
  («سرویس تست شما با موفقیت به سرویس فعال تبدیل شد ✅») is sent **only**
  from the order-fulfillment dispatch, only when the executor outcome
  carries `trialConverted === true` — i.e. only by the ONE operation
  that performed the conversion. Idempotent replays return
  `alreadyApplied` and never re-enter that branch; reconciliation never
  sends it.
- Conversion changes nothing else: `source` stays `FREE_TRIAL` (origin
  visible), no trial allowance is restored, no new trial claim is
  permitted by it, and the label on the detail page flips to
  «شروع‌شده با اکانت تست».

## Sweep protection for converted services

The trial sweep still expires the **claim** on schedule, but a converted
service (or one whose paid renewal already moved its own `expiresAt`
into the future) is a normal paid-lifecycle service now — step 1 of
`runFreeTrialSweep`:

- the `Service` is never flipped to `EXPIRED` by the sweep
  (`convertedToPaidAt IS NULL` is part of the update's WHERE, plus the
  future-expiry check);
- `testAutoDisableAfterExpiry` never disables the remote account of a
  converted service.

## Financial isolation, restated

The trial **creation** path remains fully non-financial (see
`docs/free-trial-architecture.md` — no `Order`, `Payment`,
`WalletTransaction`, discount usage, referral effects or paid counters).
Paid operations **on** a trial service are ordinary revenue: a normal
`CheckoutSession` → `Payment` → `Order` per the payment lifecycle, with
normal statistics — nothing about the trial origin discounts or hides
them. Locked by suite A tests (A13: the initial trial writes zero
financial rows; the converting renewal is normal revenue).
