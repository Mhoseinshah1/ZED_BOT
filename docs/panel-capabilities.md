# Panel Capability Model

Explicit, static declaration of which operations each panel adapter
actually implements and has tested - used to block unsupported operations
**before payment** instead of discovering them after the money moved.

## Capabilities

| Capability | Marzban | XUI (SANAEI) |
|---|---|---|
| `authenticatedHealth` | ✅ | ✅ |
| `createService` | ✅ | ✅ |
| `readService` | ✅ | ✅ |
| `renewService` | ✅ | ✅ |
| `addVolume` | ✅ | ✅ |
| `addTime` | ✅ | ✅ |
| `toggleService` | ✅ | ✅ |
| `regenerateSubscription` | ✅ | ✅ |
| `deleteService` | 🚫 | 🚫 |
| `reconciliation` | ✅ | ✅ |

Declared in `packages/panel-adapters` (`MARZBAN_CAPABILITIES`,
`XUI_CAPABILITIES`) and exposed on every adapter instance
(`adapter.capabilities`). `deleteService` is unimplemented as a *service
operation* for both families; the low-level delete endpoints exist solely
for XUI compensating cleanup and opt-in staging cleanup. The XUI
lifecycle capabilities became real in the global-client lifecycle phase
(`docs/xui-global-client-lifecycle.md`): each is backed by the pinned
upstream endpoint, an implementation with verify-after-write, and
contract tests - never by documentation presence alone.

**XUI remote-model gate**: even on a capable panel, lifecycle mutations
additionally require the SERVICE's remote model to be `GLOBAL_CLIENT`
(`classifyXuiRemoteModel`); legacy per-inbound and unprovable services are
blocked before payment (`serviceSupportsGlobalLifecycle`).

## Where capabilities gate behavior

| Gate | Mechanism |
|---|---|
| Catalog display + checkout + wallet payment (purchases) | `isProductVisible` -> `isPanelSellable` |
| Renewal listing / plan validity / payment | `renewableWhere` + `isRenewalPlanValid` -> `renewService` |
| Extra volume listing / package validity / payment | `eligibleWhere` + `isExtraVolumePackageValid` -> `addVolume` |
| Extra time listing / package validity / payment | analogous -> `addTime` |
| Enable/disable button | `toggleServiceStatus` -> `toggleService` |
| Regenerate subscription button | `regenerateServiceSubscription` -> `regenerateSubscription` |
| provisionPaidOrder preflight | local config assessment (definite failure -> refund) |

Because the wallet-payment functions re-validate visibility/plan validity
immediately before charging, the same gates cover "payment is finalized".

## Sellability

A SERVICE product is sellable only when its panel satisfies **all** of:

1. `status = ACTIVE`;
2. the panel type/variant supports `createService`;
3. the LOCAL configuration assessment passes (credentials present; Marzban:
   template or explicit protocol settings; XUI: supported variant + at
   least one inbound id);
4. the last persisted authenticated readiness check did not fail
   (`provisioningReady !== false`).

`provisioningReady = null` (never tested, or reset by a config edit) keeps
a locally-complete panel sellable so existing deployments don't break; an
explicitly failed test blocks sales until an admin re-tests successfully.

## Authenticated readiness

`PanelAdapter.checkProvisioningReadiness()` runs the real check per family
(see docs/marzban-provisioning.md and docs/xui-provisioning.md) and
reports ordered steps: reachable, auth, read-endpoint, template (Marzban),
inbounds (XUI), config. The admin «تست اتصال» renders the steps in
Persian, persists `provisioningReady` / `lastCapabilityCheckAt` /
`capabilitySnapshot` (sanitized JSON - never credentials/cookies) and
shows a read-only capability list. **Reachability alone never marks a
panel ready.** Editing any provisioning-relevant panel field (base URL,
credentials, template, inbound ids, protocol settings, subscription
domain, variant) resets the persisted result to "untested".

## Admin UI statuses

«آماده ساخت سرویس» · «تنظیمات ناقص» · «احراز هویت ناموفق» ·
«اینباند تنظیم نشده» · «کاربر الگو یافت نشد» · «نسخه API پشتیبانی نمی‌شود» ·
«اتصال برقرار است اما ساخت سرویس قابل تایید نیست» · «پنل در دسترس نیست»

The XUI panel-detail page additionally lists the verified per-operation
capability statuses (`panelCapabilityStatusLines`): ساخت سرویس ·
بروزرسانی سرویس · تمدید · حجم اضافه · زمان اضافه · فعال/غیرفعال ·
تغییر لینک · تطبیق پنل, each shown as «پشتیبانی می‌شود ✅» /
«پشتیبانی نمی‌شود ❌» / «نیازمند تست مجدد» / «نسخه API ناسازگار است».
«پشتیبانی می‌شود» requires BOTH the adapter implementation and a passing
persisted readiness test; an unsupported `apiVariant` marks every
operation «نسخه API ناسازگار است».

## Free trials

Free-trial availability rides the same capability model
(`assessTrialPanelConfig` in `apps/bot/src/services/free-trial.service.ts`):
a panel can serve trials only when it satisfies the purchase-grade
provisioning bar — `status = ACTIVE`, the adapter supports
`createService`, the local configuration assessment passes, and the last
persisted readiness check did not fail (`provisioningReady === false`
blocks; `null`/untested does not) — PLUS the trial-specific config
(positive duration and traffic, valid capacity, complete naming config,
and for XUI a non-empty `testInboundIds` subset of the panel allowlist).
**Readiness invalidation applies unchanged**: editing any
provisioning-relevant panel field resets the persisted readiness result,
and an explicitly failed «تست اتصال» blocks trials exactly as it blocks
sales. See `docs/free-trial-architecture.md`.

## Outcome model (provisioning flow safety)

`createServiceAccount` results distinguish four outcomes:

| Outcome | Meaning | Order handling |
|---|---|---|
| `ok: true` | definite success | Service persisted, order COMPLETED |
| `ok: false` (no `uncertain`) | definite failure - the panel state is untouched (config error, 4xx, confirmed cleanup) | FAILED + wallet refund |
| `ok: false, notFound` (reads) | definite remote absence | reconciliation refunds |
| `ok: false, uncertain: true` | UNKNOWN/partial remote state | order STAYS `PROVISIONING`; **never auto-refunded**; startup reconciliation settles it from panel truth under the same distributed lock |

This integrates with the existing reconciliation design
(docs/panel-database-reconciliation.md): uncertainty never moves money.
