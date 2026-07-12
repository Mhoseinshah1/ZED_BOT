# Corrective UI/UX Fix C

Real source-code changes: the admin user-management tree (landing filters,
focused detail, confirmed block/unblock, read-only sub-pages), the
products/categories tree (root, type/status filters, type-specific detail
actions, wizard double-click safety), and the panels tree (root filters,
secret-free list/detail, linked products) — all with direct-parent backs.

**Explicitly true after Fix C:** no schema migration; no user/service
provisioning change; no financial-mutation change (wallet adjustments stay
the untouched Phase 20 atomic flow); no credential exposure (values never
render — only «تنظیم شده ✅ / تنظیم نشده ❌»); no destructive
category/product/panel deletion (all deletes were and remain
soft-deactivations); subscription purchase unchanged (`user:buy`);
OTHER_PRODUCT remains a separate section.

## Admin users tree

Landing «مدیریت کاربران 👤»: جستجوی کاربر 🔎 / کاربران اخیر 🕘 ·
کاربران مسدود 🚫 / کاربران فعال ✅ · کاربران غیرفعال ⏸ / بازگشت به پنل
ادمین. Filters map to EXISTING `UserStatus` values (active→ACTIVE,
blocked→BLOCKED, inactive→DISABLED; recent = newest of everything except
DELETED — no invented statuses). Lists are paged (10/page,
`admin:users:ls:<r|a|b|d>:<page>`); the old «کاربران اخیر» callback
answers with the new recent list.

Search accepts Telegram numeric id (exact, ≤15 digits), username with or
without @ (case-insensitive), internal short id (ambiguity-safe uuid
prefix), first/last name and phone fragments — trimmed, capped at 10
results, all values escaped.

### User detail

Identity (short id, Telegram id, name, username, phone, joined, last seen,
status, group) · financial (balance, total credits = charged+manual-add,
total debits = spent+manual-deduct, pending/successful order counts) ·
activity (services/active services, orders, payments, tickets) · referral
(inviter + referral count). All escaped; no raw JSON/secrets.

Keyboard: کیف پول کاربر 💰 · سرویس‌های کاربر 🛍 / سفارش‌های کاربر 🧾 ·
پرداخت‌های کاربر 💳 / مسدود کردن کاربر 🚫 (ACTIVE) یا رفع مسدودی کاربر ✅
(BLOCKED — both behind an explicit confirmation; `setUserBlocked` is a
guarded status-only updateMany) / بازگشت به رسید 🧾 (Fix B context) /
بازگشت به نتایج یا بازگشت به لیست (same filter/page) / بازگشت به مدیریت
کاربران / بازگشت به منوی ادمین. **Deferred (no dead buttons):** per-user
ticket list and referral-member list pages — the counters render in the
text instead.

### Wallet / services / orders / payments sub-pages

- Wallet: existing Phase 20 page + «تاریخچه تراکنش‌ها 📋»
  (`admin:user_wallet:tx:<sid>:<page>`, reusing the read-only
  `listWalletTransactions`); افزایش ➕ / کاهش ➖ keep the untouched two-step
  confirmed atomic MANUAL_ADD/MANUAL_DEDUCT flow with user notification;
  the Fix B «بازگشت به رسید 🧾» is preserved.
- Services `admin:users:svc:<sid>:<page>` — read-only rows (name, status,
  panel snapshot, expiry); no subscription/config links ever.
- Orders `admin:users:ord:<sid>:<page>` — type, snapshot name, amount,
  status, date (labels reused from the Phase 30 history service).
- Payments `admin:users:pay:<sid>:<page>` — each row opens the existing
  Fix B payment/receipt detail (`admin:rec:view:<sid>`).
All 10/page, back to the same user detail.

## Products / categories tree

Root «مدیریت محصولات و پلن‌ها 🛍»: لیست محصولات 🧾 · افزودن محصول ➕
(type chooser → the existing SERVICE/OTHER wizards) / دسته‌بندی‌ها 🗂 ·
افزودن دسته‌بندی ➕ / محصولات اشتراک VPN 🔐 · محصولات دیگر 🛍 /
بازگشت به پنل ادمین. «محصولات دیگر» here is CONFIGURATION only — orders
and stock stay under the Fix B OTHER_PRODUCT landing.

List filters: all / SERVICE_PRODUCT / OTHER_PRODUCT / **active (V)** /
**inactive (X)** (`admin:prod:ls:<S|O|A|V|X>:<page>`); rows show status
icon, name, price, category (+ type suffix on mixed lists); the list page
carries add-product/categories shortcuts; details return to the same
filter/page via session context.

Detail actions — SERVICE_PRODUCT: name/price/invoice/duration/order edits,
category/groups, volume, **تغییر پنل** (ACTIVE panels only, current panel
shown, with the required warning «تغییر پنل محصول فقط روی خریدهای بعدی
اثر می‌گذارد.») and location (+ Marzban traffic reset). OTHER_PRODUCT:
required-info toggle/prompt, delivery type, **مدیریت موجودی استاک 🎟**
(direct link to the Fix B stock product page) — and the panel picker is
refused for OTHER_PRODUCT even via old callbacks (guarded in both the
picker and setter routes). Deactivate stays the only "delete"; final rows:
بازگشت به لیست محصولات (same filter/page) / بازگشت به مدیریت محصولات.

Wizard: type chooser → the existing validated steps → preview → «ذخیره ✅».
The wizard state is now consumed BEFORE the create, so a double-clicked
save cannot create twice; nothing is written before the final confirm
(single `createProductAtOrder` call site).

Categories: unchanged flows; the delete ask/confirm remains an explicit
soft-deactivate («حذف فیزیکی انجام نمی‌شود») and a category with products
is never removed.

## Panels tree

Root «مدیریت پنل‌ها 🖥»: لیست پنل‌ها 🧾 · افزودن پنل ➕ / پنل‌های فعال ✅ ·
پنل‌های غیرفعال ⏸ (`admin:panels:ls:<a|i>:<page>`) / بازگشت به پنل ادمین.
**Deferred:** «تست همه پنل‌های فعال 🩺» — no existing bulk-test helper, not
invented; the per-panel «تست اتصال 🩺» covers it.

List rows: status icon, name, type, **hostname only** (never the full URL,
never credentials). Detail: short id, type, hostname, «اطلاعات ورود:
تنظیم شده ✅ / تنظیم نشده ❌» (value never rendered), linked-product count,
created/updated, plus all pre-existing real settings pages
(features/pricing/test/username/cfg). New «محصولات متصل 🛍»
(`admin:panel:prods:<sid>`) lists the actually-linked products and opens
the existing product detail. Backs: بازگشت به لیست پنل‌ها (same
filter/page via session) / بازگشت به مدیریت پنل‌ها. The add wizard keeps
its existing sequence (type → name → URL → credentials → save) with
`normalizePanelBaseUrl` validation, encrypted credentials,
`maskSecretEdges` previews and soft delete only; a failed «تست اتصال»
renders a safe message with retry via the same button.

## Product–panel linking

SERVICE_PRODUCT may link to an ACTIVE panel; OTHER_PRODUCT never.
Changing a product's panel updates the Product row only — existing
Service rows are never migrated (the products handler contains no
`prisma.service` access), and the UI shows the future-purchases-only
warning. Selection applies on tap (the pre-existing approved flow); an
extra confirm step is a documented deferral.

## Callback compatibility

`admin:users:recent`, `admin:users:view/search/results`,
`admin:user_wallet:*`, `admin:prod:*` (old S/O/A lists, wizards, pickers),
`admin:panels:list[:page]`, `admin:panel:*` — all unchanged and answering.
New callbacks are additive and stay under 64 bytes with ambiguity-safe
short ids.

## Deferred

- Per-user ticket list and referral-member list pages.
- Bulk «تست همه پنل‌های فعال».
- Extra confirmation step on product-panel selection.
- User/device-limit and protocol fields on products (no schema support —
  not invented).

## Tests

`apps/bot/tests/corrective-fix-c.test.ts` (14 tests): exact users landing,
escaped profile fields, block/unblock button gating + confirmation +
guarded DB flip (no side effects, stale confirmations refused), search
normalization (id/@username/short id) on DB, read-only sub-list lock,
receipt-context regression, exact product root/type chooser, V/X filters,
type-specific detail actions, OTHER_PRODUCT panel-guard, single-create +
consume-before-create wizard locks, soft-delete locks, same-filter/page
backs, panel root/list/detail structure, hostname-only + no-credential
rendering, secret masking and locked CB constants. Fix A/B suites pass
unchanged (one Fix B row-shape assertion updated for the intentionally
widened profile keyboard, its invariant — no receipt button without
context — preserved).
