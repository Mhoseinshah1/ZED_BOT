# Admin payment provider management (provider-navigation phase)

This is the admin layer above the payment gateway system
(`docs/payment-architecture.md`): every payment method the bot supports is
visible and switchable from one place, without code edits or deploys. It is
**pure configuration** — nothing here creates Payments, Orders or
CheckoutSessions, and the gateway adapters in `@zedbot/payments` are only
ever used read-only.

The provider-navigation phase reshaped the original single-screen page into
a **compact list → per-provider detail** design: the list shows one button
per provider with its live status; all provider-specific information and
actions live on the provider's own detail page.

Source: `apps/bot/src/services/admin-payment-provider.service.ts` (service),
`apps/bot/src/handlers/admin-finance/admin-finance.handler.ts` +
`admin-finance-views.ts` (routes/rendering).
Tests: `apps/bot/tests/payment-provider-admin.test.ts` (service/flow) and
`apps/bot/tests/payment-provider-navigation.test.ts` (list/detail
navigation).

## The managed-provider registry

`MANAGED_PROVIDERS` is a fixed, ordered registry of the five providers the
admin manages:

| Key (stable) | Display name (default) | نوع | Backed by | Connection test | Config guard on enable |
| --- | --- | --- | --- | --- | --- |
| `CARD_TO_CARD` | 💳 کارت‌به‌کارت | پرداخت دستی با رسید | `PaymentGateway` row | — | — |
| `WALLET` | 🏦 کیف پول | پرداخت از موجودی داخلی کاربر | `wallet_payment_enabled` Setting (**virtual**) | — | — |
| `ZARINPAL` | 🇮🇷 زرین‌پال | پرداخت آنلاین ریالی | `PaymentGateway` row | ✅ | ✅ |
| `NOWPAYMENTS` | 🪙 پرداخت کریپتویی | پرداخت کریپتویی | `PaymentGateway` row | ✅ | ✅ |
| `TELEGRAM_STARS` | ⭐ پرداخت با Telegram Stars | پرداخت داخل تلگرام | `PaymentGateway` row | — | ✅ |

**WALLET is virtual**: there is no `WALLET` value in `PaymentGatewayType`
and no gateway row for it. Its on/off switch is the existing Phase 22
`wallet_payment_enabled` Setting (`payment-settings.service`), so the
provider page and the older «تنظیمات پرداخت و کیف پول» page flip the exact
same switch and can never disagree.

The **key** is what identifies a provider everywhere (callback data, logs,
lookups). Display names are cosmetic — an admin/DB rename never changes
behavior (`managedProviderMeta("زرین‌پال")` is deliberately `null`).

## Navigation: list → detail

پنل مدیریت 🛠 → «مالی 💎» → «روش‌های پرداخت 💳». The finance composer is
mounted behind `adminAuthMiddleware()` in `app.ts`, and the `payprov:*`
callbacks are routed through the **same gated admin area** as `admin:*` —
an ordinary user (or a forged callback) is denied before any handler runs.
No new root-level admin menu item was added.

### List page (`admin:finance:methods`)

Title «مدیریت روش‌های پرداخت 💳» + «روش پرداخت موردنظر را انتخاب کنید.»
(both MessageTemplates). Exactly **one button per provider**, labeled with
its emoji, display name and **live status** — e.g. `🏦 کیف پول — فعال ✅`,
`🇮🇷 زرین‌پال — غیرفعال ❌` — plus «بازگشت به مالی». There are **no**
generic action buttons on the list. Opening the list runs
`ensureProviderGateways()` (idempotent bootstrap: one row per real provider
type, online providers created **DISABLED**, existing rows never touched).

### Stable callback identifiers

Every provider button carries the stable provider key, never a label:

| Callback | Meaning |
| --- | --- |
| `payprov:view:<KEY>` | open the provider's detail page |
| `payprov:toggle:<KEY>` | ask the enable/disable confirmation |
| `payprov:toggle:<KEY>:on\|off` | confirmed enable/disable (direction baked in — a stale button can never flip the wrong way) |
| `payprov:settings:<KEY>` | open the provider-specific settings flow |
| `payprov:test:<KEY>` | run the connection test (testable providers only) |

The longest emitted value (`payprov:toggle:TELEGRAM_STARS:off`, 33 bytes)
stays far under Telegram's 64-byte callback-data limit. The pre-refactor
`admin:fin:pm:{t,s,c}:<KEY>` routes stay registered as aliases of the same
handlers, so stale buttons on old messages keep answering; they are never
emitted anymore.

### Detail pages (`payprov:view:<KEY>`)

Every detail page shows the display name, وضعیت (فعال ✅ / غیرفعال ❌), نوع,
آمادگی استفاده (آماده ✅ / ناقص ❌) and the provider's presence-only config
lines; testable providers also show آخرین تست اتصال (موفق ✅ / ناموفق ❌
with the timestamp, or «بررسی نشده» before the first run). No field is ever
rendered empty.

Actions per provider (ButtonText-backed labels):

- **all providers**: one state-matching toggle («فعال کردن» when disabled,
  «غیرفعال کردن» when enabled) and «بازگشت به روش‌های پرداخت»;
- `CARD_TO_CARD`: «تنظیمات کارت‌به‌کارت» → the existing Phase 21
  card-management pages (accounts, limits, instruction) — their back
  buttons return to the card detail page;
- `WALLET`: «تنظیمات کیف پول» → the existing Phase 22 wallet/payment
  settings page;
- `ZARINPAL` / `NOWPAYMENTS`: «تنظیمات» → a **read-only env-config status
  page**, plus «تست اتصال»;
- `TELEGRAM_STARS`: «تنظیمات» → the read-only config page (bot connection
  flag, واحد پرداخت XTR, نرخ ستاره). **No connection-test button** — no
  meaningful Bot API readiness probe exists, and no fake test is invented.

Wallet/card have no connection test either (nothing external to probe).

## Enable / disable flows

Both directions ask a Persian confirmation first
(«آیا از فعال کردن/غیرفعال کردن این روش پرداخت مطمئن هستید؟»); «انصراف»
returns to the detail page. After every action the detail page is
re-rendered with fresh state and the result line on top.

`setProviderEnabled(key, enabled, adminId)`:

- **Enable guard**: providers whose configuration lives outside the admin
  page (`ZARINPAL`, `NOWPAYMENTS`, `TELEGRAM_STARS`) re-fetch their config
  at action time and refuse to enable while it is incomplete —
  «تنظیمات این درگاه کامل نیست و امکان فعال‌سازی آن وجود ندارد.» Card and
  wallet stay switchable (their config is fixable right on their own
  pages, and an enabled card gateway without active cards is already
  hidden from users by the visibility filters).
- **Exactly once**: real rows flip with a compare-and-set `updateMany`
  (`WHERE isEnabled = !target`); a duplicate action (double click, stale
  confirmation, second admin) reports `{ok: true, changed: false}` and the
  admin sees «این روش پرداخت از قبل فعال است.» /
  «این روش پرداخت از قبل غیرفعال است.» — never a fake second success. The
  WALLET switch gets the same duplicate detection against the Setting.
- **Disable deletes nothing**: the switch is the only thing that changes.
  Gateway config (`configEncrypted`), card accounts, the wallet Setting
  row and every existing `Payment` row survive untouched; in-flight
  external payments are not cancelled. The provider merely disappears from
  user selection.

## Connection tests

`testProviderConnection(key)` returns a status — `OK`, `FAILED`,
`INCOMPLETE` (config missing: no probe fired, nothing persisted) or
`UNSUPPORTED` (no meaningful test exists: no request, no persistence).

- **NOWPayments**: `GET <host>/v1/status` — the official public status
  endpoint; HTTP 200 with a JSON body = OK. Read-only, no payment-side
  effects.
- **Zarinpal**: there is **no side-effect-free ping endpoint**, so the test
  POSTs `pg/v4/payment/verify.json` with a well-formed **dummy** authority
  (`"A"` + 35 zeros) and a tiny amount. `verify.json` creates nothing
  server-side, and *any* structured v4 envelope answer (`data`/`errors` —
  including an error code like "authority not found") proves both
  connectivity and the expected API shape. Only transport failures,
  timeouts and non-JSON answers fail. No payable transaction is created.

Hosts come from the `@zedbot/payments` config readers (`*_BASE_URL`
override, then sandbox/production defaults); requests use the package's
`paymentHttpTimeoutMs()` and `readJsonSafely()` helpers. OK/FAILED results
persist `lastCheckedAt` + `healthStatus` on the gateway row and render as
آخرین تست اتصال on the detail page. Admin-facing results are fixed
templates — «اتصال با موفقیت برقرار شد ✅» /
«اتصال به سرویس پرداخت برقرار نشد.» / «تنظیمات این درگاه ناقص است.» — raw
provider errors never surface.

## Config status pages are presence-only

For env-configured providers the settings page shows **whether** each value
is set — `تنظیم شده ✅` / `تنظیم نشده ❌` — and never the value itself:

- ZARINPAL: Merchant ID, Callback, Sandbox mode;
- NOWPAYMENTS: API Key, IPN Secret, Callback, نرخ تبدیل, Sandbox mode;
- TELEGRAM_STARS: اتصال ربات (the enable switch), واحد پرداخت XTR,
  نرخ ستاره (the `StarsPricingSetting` manual rate);
- CARD_TO_CARD shows the active-card count and WALLET the top-up min/max —
  operator-set amounts, not secrets, so their values are shown. Card
  numbers render **masked** everywhere on the admin side.

Credentials remain env-only (`ZARINPAL_MERCHANT_ID`,
`NOWPAYMENTS_API_KEY`, …) and are **not editable from the bot**; the page
says so explicitly. `listManagedProviders()` output never contains an env
value, so no render path can leak one — the merchant ID, API key, IPN
secret and bot token can never appear on any page.

## User visibility rules

A provider is selectable by a paying user only when **both** hold
(`payment-method.service.getAvailablePaymentMethods`):

1. its gateway row is `isEnabled` (and passes the existing
   hidden/limits/group/paid-count filters, and CARD_TO_CARD has an active
   card);
2. for online providers, its adapter reports `isAvailable()` — env
   credentials present (and for Stars a positive manual rate).

Disabling a provider removes it from the method list immediately, and the
checkout handler re-checks `gateway.isEnabled` when a method button is
clicked — a forged or stale callback for a disabled provider answers
«این روش پرداخت در حال حاضر فعال نیست.» (`payment_gateway_unavailable_text`)
and never creates a payment. `gateway-payment.service` re-checks again at
payment-creation time.

Empty state: when the user has **no** methods and at least one online
gateway row exists but is dormant — admin-disabled **or**
adapter-unavailable (`hasDormantOnlineGateways()`) — the checkout screen
shows `payment_no_online_methods_text` («در حال حاضر روش پرداخت فعالی وجود
ندارد. لطفاً با پشتیبانی تماس بگیرید.»). A pure amount/group filter keeps
the generic no-methods text.

## Texts

Seeded in `packages/database/src/seed-data.ts` and editable from «مدیریت
متن‌ها ✍️» like every other template.

MessageTemplates (category `payment`): `payment_methods_admin_header`,
`payment_provider_pick_text`, `payment_provider_enable_confirm`,
`payment_provider_disable_confirm`, `payment_provider_enabled_text`,
`payment_provider_disabled_text`, `payment_provider_already_enabled_text`,
`payment_provider_already_disabled_text`,
`payment_provider_config_incomplete_text`, `payment_provider_test_ok_text`,
`payment_provider_test_failed_text`,
`payment_provider_test_incomplete_text`, `payment_no_online_methods_text`,
`payment_gateway_unavailable_text`.

ButtonTexts: `pm_enable` (فعال کردن), `pm_disable` (غیرفعال کردن),
`pm_settings` (تنظیمات), `pm_settings_wallet` (تنظیمات کیف پول),
`pm_settings_card` (تنظیمات کارت‌به‌کارت), `pm_test` (تست اتصال),
`pm_back_providers` (بازگشت به روش‌های پرداخت). Button *keys* are stable;
operators may retitle the visible labels freely — callbacks never depend on
them.

## Security rules

- **Stable keys in callbacks**: `payprov:*` routes carry the provider enum
  key (`[A-Z_]+`) — never display names — so renames can't break or
  redirect actions, and the routes sit behind the admin auth middleware.
- **Presence-only rendering**: config pages and `listManagedProviders()`
  emit `تنظیم شده/نشده` markers, never env values.
- **Safe-field-only audit logging**: enable/disable logs exactly
  `{provider, adminId}` (plus the blocked-enable event), connection tests
  `{provider, status}` — no credentials, no provider payloads, no raw
  errors.
- **No side effects**: bootstrap/list/test never create payment rows; the
  Zarinpal probe is a dummy verify by design; disable deletes nothing.

The test suites lock all of the above: route gating and orphan-free
callbacks (source assertions), the 64-byte callback budget, idempotent
bootstrap, the enable config guard, CAS enable/disable + duplicate
protection (including the virtual WALLET), config/card/Payment survival
across disables, user visibility + the dormant-gateway empty state, secret
hygiene in rendered pages and logs, and both connection probes against a
local mock server.

## Database migration

`packages/database/prisma/migrations/20260714063338_payment_provider_admin`
— additive columns on `PaymentGateway`, no backfill needed:

| Column | Type | Purpose |
| --- | --- | --- |
| `description` | `TEXT?` | optional admin-facing description |
| `lastCheckedAt` | `TIMESTAMP?` | when the last connection test ran |
| `healthStatus` | `TEXT?` | `"OK"` / `"FAILED"` — never raw provider errors |
