# Free-trial admin management

How operators configure and monitor free-trial VPN accounts. Companion to
`docs/free-trial-architecture.md` (design) and
`docs/free-trial-security.md` (threat model).

Source of truth:
`apps/bot/src/services/free-trial-settings.service.ts` (global settings),
`apps/bot/src/handlers/admin-settings/text-settings.handler.ts`
(the global «تنظیمات اکانت تست 🎁» page),
`apps/bot/src/handlers/panels/panel.handler.ts` /
`panel-views.ts` / `panel-fields.ts` / `panel-cb.ts` (the per-panel page),
`apps/bot/src/services/free-trial.service.ts`
(`getFreeTrialMenuAvailability`, `assessTrialPanelConfig`,
`trialStatsForPanel`),
`apps/bot/src/services/free-trial-admin.service.ts` (per-user admin
mutations + audit),
`apps/bot/src/handlers/admin-users/trial-management.handler.ts` (the
per-user «مدیریت اکانت تست 🎁» page) and
`apps/bot/src/handlers/admin-settings/trial-entitlements.handler.ts`
(quota dashboard + campaign builder). Companions:
`docs/free-trial-entitlements.md` (allowance model),
`docs/free-trial-campaigns.md` (bulk campaigns).

## Global settings (Setting registry)

Same pattern as the payment settings: key constants with built-in
fallbacks over the `Setting` table — **not seeded**, reads fall back
safely when the row is missing. The global kill-switch
(`free_trial_enabled`) is managed from the dedicated
[global settings page](#the-global-settings-page-تنظیمات-اکانت-تست-) below;
the remaining keys are operator-set `Setting` rows without a Telegram
page yet.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `free_trial_enabled` | BOOLEAN | **`false`** | Global kill-switch. The feature is **disabled by default** for fresh and existing installations; nothing renders and every claim is denied until an operator explicitly enables it. |
| `free_trial_once_per_user` | BOOLEAN | `true` | Lifetime policy: one trial per user across the whole bot. |
| `free_trial_cooldown_days` | NUMBER | unset (`null`) | Optional cooldown in days between trials; only meaningful when once-per-user is off. Non-positive/unset = no cooldown. |
| `free_trial_require_no_previous_purchase` | BOOLEAN | `false` | When on, users with any successful paid order (`paidOrdersCount > 0`) are denied. |
| `free_trial_require_channel_membership` | BOOLEAN | `false` | When on, trial claims additionally require the forced-join membership gate. Inherits the current force-join placeholder behavior (no real `getChatMember` yet — see limitations). |
| `free_trial_notice_text` | STRING | `""` | Optional operator notice appended to the user's trial confirmation page. |
| `free_trial_default_allowance` | NUMBER | unset (`""`) | Trial-entitlement phase: explicit DEFAULT allowance per user. Unset preserves the legacy semantics exactly (once-per-user on → 1, off → unlimited); a per-user override wins over it. See `docs/free-trial-entitlements.md`. |

Per-panel readiness gates on top of these — the global switch alone never
makes a trial available.

## The global settings page («تنظیمات اکانت تست 🎁»)

Path: **پنل ادمین → تنظیمات عمومی ⚙️ → تنظیمات اکانت تست 🎁**
(`admin:trial_settings`), OWNER-only. This is the one place that flips
`free_trial_enabled` and the one place that explains — with the exact
shared-policy reason — why the user main-menu button is hidden. No new
root-level admin menu item: the page lives inside the existing general
settings landing.

The page («🎁 تنظیمات اکانت تست رایگان») renders four diagnostics blocks,
all computed by `getFreeTrialMenuAvailability()` (the SAME classifier the
user menu uses — the admin view can never disagree with what users see):

- «وضعیت سراسری:» — «فعال ✅» / «غیرفعال ❌» (the Setting);
- «پنل‌های آماده تست:» — count of panels claimable right now;
- «پنل‌های فعال ولی ناقص:» — trial-enabled panels that are not ready;
- «وضعیت نمایش دکمه کاربر:» — «نمایش داده می‌شود ✅» / «مخفی است ❌»,
  plus, when hidden, «علت مخفی بودن دکمه:» with exactly one of:
  - «تست رایگان به‌صورت سراسری غیرفعال است.» (`GLOBAL_DISABLED`)
  - «هیچ پنل آماده‌ای برای ساخت اکانت تست وجود ندارد.» (`NO_READY_PANEL`)
  - «تنظیمات پنل‌های تست کامل نیست.» (`PANEL_CONFIG_INCOMPLETE`)
  - «هیچ اینباند معتبری برای تست XUI انتخاب نشده است.»
    (`NO_VALID_XUI_INBOUND`)

Keyboard (stable callbacks, never derived from the Persian labels):

| Button | Callback | Action |
| --- | --- | --- |
| فعال کردن تست رایگان (only while disabled) | `admin:trial_settings:en` | two-step confirm («آیا از فعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟» » `…:en:yes`) |
| غیرفعال کردن تست رایگان (only while enabled) | `admin:trial_settings:dis` | two-step confirm («آیا از غیرفعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟» » `…:dis:yes`) |
| مشاهده پنل‌های آماده | `admin:trial_settings:ready` | safe ready-panel list (name, type, «مدت تست», «حجم تست») + a «تنظیمات پنل 🎁» link per panel to its existing trial page |
| مشاهده پنل‌های ناقص | `admin:trial_settings:inc` | per-panel safe problem sentence (`trialPanelProblemLabel`) + the same per-panel link |
| کمپین ریست اکانت تست | `admin:trialent:camp:new` | the OWNER-only campaign builder (see `docs/free-trial-campaigns.md`) |
| مدیریت سهمیه‌ها و ریست‌ها | `admin:trialent:dash` | the OWNER-only quota/reset dashboard (below) |
| بروزرسانی وضعیت ♻️ | `admin:trial_settings` | recompute + re-render |
| بازگشت به تنظیمات عمومی | `admin:general_settings` | back |

Enable flow: gate OWNER » re-read the Setting (already enabled answers
«اکانت تست رایگان از قبل فعال است.») » recompute readiness — **zero ready
panels refuses** with «امکان فعال‌سازی وجود ندارد؛ ابتدا تنظیمات اکانت
تست حداقل یک پنل را کامل کنید.» » confirmation » the confirm route
re-checks everything again (stale confirmations), then flips the Setting
with an atomic **compare-and-set**
(`compareAndSetFreeTrialEnabled(false, true)` — a conditional
`updateMany`/guarded `create`, so two racing admins can never both win) »
clears the settings cache » re-renders with «اکانت تست رایگان برای
کاربران فعال شد ✅». Disable mirrors it (idempotent answer «اکانت تست
رایگان از قبل غیرفعال است.», success «اکانت تست رایگان برای کاربران
غیرفعال شد.») and flips ONLY the Setting: panels, existing
`FreeTrialClaim` rows, trial `Service`s and remote accounts are never
touched.

The pages expose config values and counters only — never panel URLs,
credentials, tokens or raw readiness/provider errors (unknown problem
codes collapse into «پنل برای ساخت سرویس آماده نیست.»).

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

Every trial route (the global `admin:trial_settings*` pages,
`admin:panel:trial|tren|trdis|trpn|trst`, the legacy
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

## Per-user page — «مدیریت اکانت تست 🎁» (trial-entitlement phase)

Path: **پنل ادمین → مدیریت کاربران 👤 → جزئیات کاربر →
«مدیریت اکانت تست 🎁»** (`admin:users:trial:<sid>`). Any active admin may
open it; two operations inside are OWNER-only (marked below). The page
(«🎁 مدیریت اکانت تست کاربر») renders `trialManagementSummary`: used
count, remaining («نامحدود» for the unlimited legacy default), active
trial / provisioning flags, last trial date, cooldown end, access state
(«مجاز»/«غیرمجاز»), claim counters by status, converted-service count
and grant counters (فعال/منقضی/لغوشده) — **no subscription URLs, tokens
or remote client ids are ever rendered**.

Every mutation flows through `free-trial-admin.service.ts` (validation +
apply + audit); the handler only renders, collects input and confirms.
Drafts live in the session with a one-shot nonce as idempotency key and
are **consumed before the mutation runs** — a double-clicked
confirmation finds no draft, and the nonce-keyed `idempotencyKey`
absorbs retried deliveries.

| Button | Callback | Flow |
| --- | --- | --- |
| افزودن سهمیه تست | `admin:users:trial:g:<sid>` | scope («همه پنل‌ها» / «پنل مشخص» → ACTIVE panel picker) → count (1–100) → expiry («بدون تاریخ انقضا» / «اعتبار برای چند روز» → days 1–365) → mandatory reason (3–500 chars) → confirm (`…:gok`). Creates one `ADMIN_GRANT` entitlement, key `trial-grant:<nonce>` |
| تنظیم تعداد تست باقی‌مانده (**OWNER**) | `admin:users:trial:sr:<sid>` | shows the current remaining → new value (0–100) → reason → confirm (`…:srok`). `setEffectiveRemaining`: revokes every usable remainder (rows keep historical values), pins the default pool via the per-user override, and grants one fresh `ADMIN_RESET` row carrying the new remaining; key `trial-setrem:<nonce>`. Success «تعداد تست باقی‌مانده کاربر بروزرسانی شد ✅» |
| ریست دسترسی تست | `admin:users:trial:rs:<sid>` | reason → confirm text «با ریست دسترسی، تاریخچه قبلی حذف نمی‌شود و کاربر دوباره امکان دریافت تست خواهد داشت.\n\nادامه می‌دهید؟» (`…:rsok`). Clears the admin barriers + waives the cooldown + grants fresh allowance (`trial-reset:<nonce>`); **refused while a live/manual-review claim exists** with «برای این کاربر یک درخواست تست در حال پردازش یا بررسی است. ابتدا وضعیت آن را مشخص کنید.». Never touches history or remote accounts |
| لغو دسترسی تست | `admin:users:trial:rv:<sid>` | reason → confirm «آیا دسترسی این کاربر به دریافت اکانت تست لغو شود؟» (`…:rvok`). Sets `freeTrialRevokedAt` — blocks FUTURE claims only |
| رفع محدودیت زمانی | `admin:users:trial:cc:<sid>` | confirm-only («محدودیت زمانی دریافت تست این کاربر برداشته شود؟» → `…:ccok:<sid>`); clears the custom barrier AND waives the setting-computed cooldown |
| تنظیم محدودیت زمانی | `admin:users:trial:sc:<sid>` | days from now (1–365) → reason → confirm (`…:scok`) — hard per-user cooldown |
| مسدودسازی موقت تست | `admin:users:trial:dn:<sid>` | days → reason → confirm (`…:dnok`) — temporary denial with its own user-facing message |
| مشاهده تاریخچه تست‌ها | `admin:users:trial:hist:<sid>:<page>` | paginated claims (5/page): short id, panel, status, frozen username, dates and «منبع سهمیه» (پیش‌فرض / ادمین / کمپین / جبران). OWNER-only force buttons per undecided claim (below) |
| مشاهده سرویس‌های تست | `admin:users:trial:svc:<sid>:<page>` | read-only `FREE_TRIAL` services: username, status, expiry and the «تبدیل‌شده به سرویس فعال» marker for converted ones — no links/tokens |
| بازگشت به جزئیات کاربر | `admin:users:view:<sid>` | back |

Persian/Arabic digits are normalized on every numeric input; commands
(`/…`) cancel any pending flow; «انصراف» (`admin:users:trial:cxl:<sid>`)
drops the draft and re-renders the page.

## Force resolution (OWNER)

For claims stuck in `PROVISIONING`/`MANUAL_REVIEW`
(`FORCE_RESOLVABLE_STATUSES`), the history page offers OWNER-only
buttons per claim:

| Button | Callback | Effect |
| --- | --- | --- |
| تطبیق مجدد با پنل | `admin:users:trial:rec:<sid>:<cid>` | runs `reconcileTrialClaim` and toasts the outcome: «اکانت روی پنل تایید شد و سرویس ثبت شد ✅» (APPLIED) / «اکانت روی پنل یافت نشد؛ درخواست ناموفق شد و سهمیه آزاد شد.» (NOT_APPLIED) / «نتیجه هنوز نامشخص است. بعداً دوباره تلاش کنید.» (UNKNOWN) |
| تایید ساخته‌شدن تست | `admin:users:trial:fc:<sid>:<cid>` | `forceClaimCreated` — runs the reconciler, which verifies the account on the panel by its frozen username; when found, the Service is persisted and the claim activates (allowance stays consumed). **Nothing is forced blindly** when the panel does not report the account |
| تایید ساخته‌نشدن تست / لغو و آزادسازی سهمیه | `admin:users:trial:fn:<sid>:<cid>` | `forceClaimNotCreated` — cancels the claim (`forced-not-created`) and releases its allowance exactly once; success «درخواست لغو شد و سهمیه آزاد شد ✅» |

Both force flows show the mandated warning before the mandatory reason
and confirmation (`…:fok`): «نتیجه ساخت این اکانت تست قطعی نیست.\n\n
آزادسازی سهمیه ممکن است باعث ساخته‌شدن بیش از یک اکانت تست شود. فقط پس
از بررسی پنل ادامه دهید.» (`TRIAL_FORCE_WARNING_TEXT`). Automatic
reconciliation is always attempted/offered first.

## Quota dashboard — «مدیریت سهمیه‌ها و ریست‌ها» (OWNER)

Path: **تنظیمات عمومی ⚙️ → تنظیمات اکانت تست 🎁 →
«مدیریت سهمیه‌ها و ریست‌ها»** (`admin:trialent:dash`), OWNER-only (every
route in the namespace). Indexed metrics only — counts and `groupBy`,
never full per-user table scans and never credentials/tokens/URLs:
active grants, users with active grants, grants expiring in the next 7
days, claims by status, converted trial services, running/completed
campaigns and failed campaign recipients.

| Button | Callback | Action |
| --- | --- | --- |
| جستجوی کاربر | `admin:trialent:search` | reuses the existing admin-users search flow verbatim (lands on the user profile → «مدیریت اکانت تست 🎁») |
| کمپین ریست تست | `admin:trialent:camp:new` | campaign builder (`docs/free-trial-campaigns.md`) |
| کمپین‌ها | `admin:trialent:camps:1` | paginated campaign list » detail (progress counters, skipped/failed recipient pages, cancel with confirmation) |
| سهمیه‌های در حال انقضا | `admin:trialent:exp:1` | ACTIVE grants expiring inside the 7-day window (user telegram id, remaining, expiry) |
| موارد نیازمند بررسی | `admin:trialent:rev:1` | `MANUAL_REVIEW` + `PROVISIONING` claims older than 15 minutes |
| بروزرسانی ♻️ | `admin:trialent:dash` | recompute |
| بازگشت | `admin:trial_settings` | back to the trial-settings page |

## Audit log

**Trial-entitlement phase: admin trial mutations are the first real
`AuditLog` writers.** `writeTrialAudit` records one row per mutation
(actor telegram id, action, entity type/id, safe before/after metadata —
never secrets, links, tokens or raw panel data); an audit failure is
logged and swallowed, never breaking the already-committed mutation.
Actions: `trial.allowance.granted`, `trial.remaining.set`,
`trial.access.reset`, `trial.access.revoked`, `trial.cooldown.cleared`,
`trial.cooldown.set`, `trial.denial.set`,
`trial.claim.forced_not_created`, `trial.claim.forced_created`,
`trial.campaign.created` / `previewed` / `started` / `cancelled`.

Trial-config mutations additionally keep their structured audit lines
via the app logger with **safe fields only**:

| Event | Fields |
| --- | --- |
| global enable / disable | `adminId`, `action: free-trial-global-enable\|free-trial-global-disable`, `readyPanelCount` (enable), `result` |
| global diagnostics viewed | `adminId`, `action: free-trial-diagnostics-view`, `readyPanelCount`, `result` (the availability reason) |
| enable / disable (per panel) | `adminId`, `panelId`, `action: trial-enable\|trial-disable`, `before`, `after` |
| toggle (`tade`) | `adminId`, `panelId`, `action: trial-toggle`, `field`, `before`, `after` |
| field edit (`tvm`/`tdm`/`tmc`/`tib`) | `adminId`, `panelId`, `action: trial-field-edit`, `field`, `before`, `after` (non-secret scalar/array values only) |

## Limitations

- Only `free_trial_enabled` has a Telegram editing page; the other global
  keys (cooldown, once-per-user, purchase/membership requirements, notice
  text, default allowance) remain operator-set Setting rows.
- `free_trial_require_channel_membership` inherits the force-join
  placeholder until real `getChatMember` verification lands.
- Manual-review escalations DM active OWNER admins directly (LogTopic
  emit infrastructure absent).
- Disabling a panel's trials (or the global switch) never expires or
  deletes existing trial accounts; expiry always flows through the sweep,
  and remote disabling requires `testAutoDisableAfterExpiry`.
