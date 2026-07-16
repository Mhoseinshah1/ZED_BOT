# Free-trial admin management

How operators configure and monitor free-trial VPN accounts. Companion to
`docs/free-trial-architecture.md` (design) and
`docs/free-trial-security.md` (threat model).

Source of truth:
`apps/bot/src/services/free-trial-settings.service.ts` (global settings),
`apps/bot/src/handlers/panels/panel.handler.ts` /
`panel-views.ts` / `panel-fields.ts` / `panel-cb.ts` (the admin page),
`apps/bot/src/services/free-trial.service.ts`
(`assessTrialPanelConfig`, `trialStatsForPanel`).

## Global settings (Setting registry)

Same pattern as the payment settings: key constants with built-in
fallbacks over the `Setting` table — **not seeded**, reads fall back
safely when the row is missing. There is no dedicated Telegram page for
these yet; they are operator-set `Setting` rows (the per-panel page below
is the interactive admin surface).

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `free_trial_enabled` | BOOLEAN | **`false`** | Global kill-switch. The feature is **disabled by default** for fresh and existing installations; nothing renders and every claim is denied until an operator explicitly enables it. |
| `free_trial_once_per_user` | BOOLEAN | `true` | Lifetime policy: one trial per user across the whole bot. |
| `free_trial_cooldown_days` | NUMBER | unset (`null`) | Optional cooldown in days between trials; only meaningful when once-per-user is off. Non-positive/unset = no cooldown. |
| `free_trial_require_no_previous_purchase` | BOOLEAN | `false` | When on, users with any successful paid order (`paidOrdersCount > 0`) are denied. |
| `free_trial_require_channel_membership` | BOOLEAN | `false` | When on, trial claims additionally require the forced-join membership gate. Inherits the current force-join placeholder behavior (no real `getChatMember` yet — see limitations). |
| `free_trial_notice_text` | STRING | `""` | Optional operator notice appended to the user's trial confirmation page. |

Per-panel readiness gates on top of these — the global switch alone never
makes a trial available.

## Per-panel fields (`Panel.test*`)

Authoritative trial config, edited on the OWNER-only trial page:

| Column | Edited via | Rules |
| --- | --- | --- |
| `testEnabled` (default `false`) | two-step enable/disable flow only | Enabling is guarded by full validation (below); disabling stops NEW claims only — existing claims/services are never touched (expiry stays with the sweep). |
| `testVolumeMb` | «تنظیم حجم» (field key `tvm`) | strictly positive integer; unlimited trial traffic is deliberately unsupported. |
| `testDurationMinutes` | «تنظیم مدت» (`tdm`) | strictly positive integer (minutes; rendered as days/hours when divisible). |
| `testMaxConcurrentAccounts` | «ظرفیت تست» (`tmc`) | strictly positive integer or `null` = no cap; counts live + unexpired ACTIVE claims. |
| `testInboundIds` | «تنظیم اینباندهای تست» (`tib`, **XUI only**) | must be a NON-EMPTY subset of `Panel.inboundIds` (`assessTrialInboundInput`); ids outside the panel allowlist are rejected at input time with the exact invalid ids. |
| `testAutoDisableAfterExpiry` (default `false`) | toggle (`tade`) | when on, the sweep also disables the remote account after expiry (best-effort). |
| `testProductName`, `testLocation`, `testMessageTemplate`, `testGuideAfterCreate` | legacy display extras | stay editable via stale keyboards only (page `test`, no button on the trial page). `testLocation ?? name` labels the panel for users; `testProductName ??` «اکانت تست رایگان» becomes the service's product-name snapshot. |

## The admin page

Path: **پنل ادمین → مدیریت پنل‌ها → جزئیات پنل → «اکانت تست 🎁»**
(`admin:panel:trial:<sid>`). The legacy «تنظیمات تست» route
(`admin:panel:ts:<sid>`) stays registered and renders the SAME trial page
so stale buttons keep working; likewise the old `testEnabled` toggle key
(`te`) no longer flips anything blindly — it re-renders the guarded trial
page.

The page («🎁 تنظیمات اکانت تست») shows: panel name, status
(«فعال ✅» / «غیرفعال ❌»), «مدت تست», «حجم تست» (unset values render
«تنظیم نشده»), «تعداد تست‌های فعال» (used / cap) and «آمادگی ساخت»
(«آماده ✅» / «ناقص ❌») — config and counters only, never credentials,
subscription URLs or claim payloads.

Keyboard (rows of ≤ 2, all callbacks far under 64 bytes):

| Button | Callback | Action |
| --- | --- | --- |
| فعال کردن / غیرفعال کردن | `admin:panel:tren:<sid>` / `admin:panel:trdis:<sid>` | two-step confirm (ask » `…:yes`), same shape as panel delete |
| تنظیم مدت · تنظیم حجم | `admin:panel:fe:<sid>:tdm` / `…:tvm` | text-input flows with validation |
| تنظیم اینباندهای تست (XUI only) · ظرفیت تست | `…:tib` / `…:tmc` | subset-validated / positive-int flows |
| ✅/❌ غیرفعال‌سازی خودکار بعد از انقضا | `admin:panel:tg:<sid>:tade` | toggle |
| پیش‌نمایش نام | `admin:panel:trpn:<sid>` | safe naming sample — no counter reservation, no remote call |
| آمار اکانت‌های تست | `admin:panel:trst:<sid>` | stats page (below) |
| بازگشت به جزئیات پنل | `admin:panel:view:<sid>` | back |

## Activation guard

Enable-confirm **re-fetches and re-validates** the panel (the
confirmation may be stale) with `assessTrialPanelConfig`, then flips
`testEnabled` with a compare-and-set (`WHERE testEnabled = false`) so
double-clicks and concurrent confirms stay idempotent. An incomplete
config answers «تنظیمات اکانت تست این پنل کامل نیست.» and never enables.
The guard reasons (machine-readable, also used for user-facing
availability as a belt over `testEnabled`):

- `panel-not-active` — panel status is not `ACTIVE`;
- `create-capability-missing` — adapter lacks `createService`;
- panel config incomplete (credentials/template/inbounds per family);
- `provisioning-readiness-failed` — last persisted readiness test failed
  (`provisioningReady === false`);
- `trial-duration-missing` / `trial-traffic-missing` — must be integers
  > 0 (unlimited traffic unsupported);
- `trial-capacity-invalid` — set but not a positive integer;
- `naming-config-incomplete` — the panel's naming strategy misses
  required fields;
- `trial-inbounds-missing` / `trial-inbounds-outside-allowlist` — XUI
  trial inbounds must be a non-empty subset of `Panel.inboundIds`.

The same assessment runs on every user-side listing AND again inside
`claimFreeTrial` — a panel that degrades after enabling silently drops
out of the user flow.

## OWNER-only restriction

Every trial route (`admin:panel:trial|tren|trdis|trpn|trst`, the legacy
`ts` route, trial field edits and trial toggles) requires
`ctx.admin.role === "OWNER"`. Non-admins are already stopped by the admin
auth middleware; an active non-OWNER admin gets only the safe toast
«دسترسی به این بخش فقط برای مالک مجموعه فعال است.» and **no trial data
at all**. The rest of the panels area remains any-admin.

**RBAC-gap note:** this gate is a local copy of the
financial-reconciliation OWNER gate — centralized role-based access
control is a documented separate task; until it lands, each OWNER-only
area carries its own guard.

## Statistics

«آمار اکانت‌های تست» (`trialStatsForPanel`) renders counters and dates
only: total claims, `ACTIVE`, in-flight (`CLAIMED` + `PROVISIONING`),
`EXPIRED`, failed/cancelled, `MANUAL_REVIEW`, last-created timestamp, and
capacity used vs. cap («بدون سقف» when uncapped). No URLs, no
credentials, no per-user listings.

## Audit log

Every trial-config mutation writes a structured audit line via the app
logger with **safe fields only**:

| Event | Fields |
| --- | --- |
| enable / disable | `adminId`, `panelId`, `action: trial-enable\|trial-disable`, `before`, `after` |
| toggle (`tade`) | `adminId`, `panelId`, `action: trial-toggle`, `field`, `before`, `after` |
| field edit (`tvm`/`tdm`/`tmc`/`tib`) | `adminId`, `panelId`, `action: trial-field-edit`, `field`, `before`, `after` (non-secret scalar/array values only) |

## Limitations

- Global settings have no Telegram editing page yet (Setting rows only).
- `free_trial_require_channel_membership` inherits the force-join
  placeholder until real `getChatMember` verification lands.
- Manual-review escalations DM active OWNER admins directly (LogTopic
  emit infrastructure absent).
- Disabling a panel's trials (or the global switch) never expires or
  deletes existing trial accounts; expiry always flows through the sweep,
  and remote disabling requires `testAutoDisableAfterExpiry`.
