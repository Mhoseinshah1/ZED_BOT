# Admin payment provider management (provider-management phase)

This phase completes the admin layer above the payment gateway system
(`docs/payment-architecture.md`): every payment method the bot supports is
now visible and switchable from one admin page, without code edits or
deploys. It is **pure configuration** — nothing here creates Payments,
Orders or CheckoutSessions, and the gateway adapters in `@zedbot/payments`
are only ever used read-only.

Source: `apps/bot/src/services/admin-payment-provider.service.ts` (service),
`apps/bot/src/handlers/admin-finance/admin-finance.handler.ts` +
`admin-finance-views.ts` (routes/rendering).
Tests: `apps/bot/tests/payment-provider-admin.test.ts`.

## The managed-provider registry

`MANAGED_PROVIDERS` is a fixed, ordered registry of the five providers the
admin manages:

| Key (stable) | Display name (default) | نوع | Backed by | Connection test |
| --- | --- | --- | --- | --- |
| `CARD_TO_CARD` | کارت‌به‌کارت | کارت‌به‌کارت | `PaymentGateway` row | — |
| `WALLET` | پرداخت با کیف پول | کیف پول | `wallet_payment_enabled` Setting (**virtual**) | — |
| `ZARINPAL` | زرین‌پال | پرداخت آنلاین ریالی | `PaymentGateway` row | ✅ |
| `NOWPAYMENTS` | پرداخت کریپتویی | پرداخت کریپتویی | `PaymentGateway` row | ✅ |
| `TELEGRAM_STARS` | پرداخت با Telegram Stars | پرداخت با Telegram Stars | `PaymentGateway` row | — |

**WALLET is virtual**: there is no `WALLET` value in `PaymentGatewayType`
and no gateway row for it. Its on/off switch is the existing Phase 22
`wallet_payment_enabled` Setting (`payment-settings.service`), so the
provider page and the older «تنظیمات پرداخت و کیف پول» page flip the exact
same switch and can never disagree.

The **key** is what identifies a provider everywhere (callback data, logs,
lookups). Display names are cosmetic — an admin/DB rename never changes
behavior (`managedProviderMeta("زرین‌پال")` is deliberately `null`).

## Bootstrap on open — safe disabled defaults

Opening the admin page (`admin:finance:methods`) runs
`ensureProviderGateways()`:

- one `PaymentGateway` row per **real** provider type is created **only if
  missing** (`CARD_TO_CARD` reuses the Phase 21
  `createCardGatewayIfMissing`, which stays enabled-by-default);
- the online providers (`ZARINPAL`, `NOWPAYMENTS`, `TELEGRAM_STARS`) are
  created **DISABLED** — a fresh install never silently exposes an online
  gateway; the admin must explicitly enable it;
- the call is idempotent and **never touches existing rows** — a customized
  name, limits, or enabled state all survive re-opens.

## The admin page

پنل مدیریت 🛠 → «مالی 💎» → «روش‌های پرداخت 💳» (مدیریت روش‌های پرداخت).
The whole finance composer is mounted behind `adminAuthMiddleware()` in
`app.ts`, so every `admin:fin:pm:*` route is admin-only.

The list page shows one section per provider: name, وضعیت (فعال ✅ /
غیرفعال ❌), نوع, and — once a connection test ran — آخرین تست اتصال with
its timestamp. Per-provider buttons (ButtonText keys `pm_enable` /
`pm_disable` / `pm_settings` / `pm_test`):

- **Enable/disable** (`admin:fin:pm:t:<KEY>`): a Persian confirmation page
  first; the confirm callback (`admin:fin:pm:t:<KEY>:on|off`) carries the
  intended direction, so a stale button can never flip the wrong way.
  `setProviderEnabled` flips real rows with a compare-and-set `updateMany`
  (`WHERE isEnabled = !target`), so a **duplicate action** (double click,
  stale confirmation, second admin) reports `{ok: true, changed: false}`
  and the user sees «این عملیات قبلاً انجام شده است.» instead of a fake
  second success. The WALLET switch gets the same duplicate detection
  against the current Setting value.
- **تنظیمات** (`admin:fin:pm:s:<KEY>`): `CARD_TO_CARD` routes into the
  existing Phase 21 card-management pages; `WALLET` routes into the Phase
  22 wallet/payment settings page; the env-configured providers get a
  **read-only config status page** — presence markers only (below).
- **تست اتصال** (`admin:fin:pm:c:<KEY>`): only rendered for ZARINPAL and
  NOWPAYMENTS.

### Config status pages are presence-only

For env-configured providers the settings page shows **whether** each value
is set — `تنظیم شده ✅` / `تنظیم نشده ❌` — and never the value itself:

- ZARINPAL: Merchant ID, Callback;
- NOWPAYMENTS: API Key, IPN Secret, Callback, نرخ تبدیل;
- TELEGRAM_STARS: the enable switch + نرخ ستاره (the `StarsPricingSetting`
  manual rate);
- CARD_TO_CARD shows the active-card count and WALLET the top-up min/max —
  operator-set amounts, not secrets, so their values are shown.

Credentials remain env-only (`ZARINPAL_MERCHANT_ID`,
`NOWPAYMENTS_API_KEY`, …) and are **not editable from the bot**; the page
says so explicitly. `listManagedProviders()` output never contains an env
value, so no render path can leak one.

## Connection tests

`testProviderConnection(key)` — supported providers only; everything else
reports `{ok: false}` without any request or DB write.

- **NOWPayments**: `GET <host>/v1/status` — the official public status
  endpoint. HTTP 200 with a JSON body = OK.
- **Zarinpal**: there is **no side-effect-free ping endpoint**, so the test
  POSTs `pg/v4/payment/verify.json` with a well-formed **dummy** authority
  (`"A"` + 35 zeros — the 36-char authority shape) and a tiny amount. `verify.json` creates nothing
  server-side, and *any* structured v4 envelope answer (`data`/`errors` —
  including an error code like "authority not found") proves both
  connectivity and the expected API shape. Only transport failures,
  timeouts and non-JSON (HTML proxy error pages) answers fail.

Hosts come from the `@zedbot/payments` config readers (`*_BASE_URL`
override, then sandbox/production defaults); requests use the package's
`paymentHttpTimeoutMs()` and `readJsonSafely()` helpers. The result is
persisted on the provider's gateway row — `lastCheckedAt` + `healthStatus`
(`"OK"`/`"FAILED"`) — and rendered as آخرین تست اتصال on the list. The
service returns **only `{ok}`**: raw provider errors never surface to the
admin UI or callers.

## User visibility rules

A provider is selectable by a paying user only when **both** hold
(`payment-method.service.getAvailablePaymentMethods`):

1. its gateway row is `isEnabled` (and passes the existing
   hidden/limits/group/paid-count filters, and CARD_TO_CARD has an active
   card);
2. for online providers, its adapter reports `isAvailable()` — env
   credentials present (and for Stars a positive manual rate).

Disabling a provider therefore removes it from the method list immediately,
and `gateway-payment.service` re-checks `gateway.isEnabled` + adapter
availability at payment-creation time, so a stale/raced selection of a
disabled provider can never create a payment.

Empty-state text: when the user has **no** methods and at least one online
gateway row exists but is dormant — admin-disabled **or**
adapter-unavailable (`hasDormantOnlineGateways()`) — the checkout screen
shows the `payment_no_online_methods_text` template («در حال حاضر روش
پرداخت آنلاین فعالی وجود ندارد.») instead of the generic no-methods text
(`user-checkout/payment.handler.ts`). A pure amount/group filter keeps the
generic text.

## Database migration

`packages/database/prisma/migrations/20260714063338_payment_provider_admin`
— additive columns on `PaymentGateway`, no backfill needed:

| Column | Type | Purpose |
| --- | --- | --- |
| `description` | `TEXT?` | optional admin-facing description |
| `lastCheckedAt` | `TIMESTAMP?` | when the last connection test ran |
| `healthStatus` | `TEXT?` | `"OK"` / `"FAILED"` — never raw provider errors |

## Texts

Seeded in `packages/database/src/seed-data.ts` and editable from «مدیریت
متن‌ها ✍️» like every other template.

8 MessageTemplates (category `payment`): `payment_methods_admin_header`,
`payment_provider_enable_confirm`, `payment_provider_disable_confirm`,
`payment_provider_enabled_text`, `payment_provider_disabled_text`,
`payment_provider_test_ok_text`, `payment_provider_test_failed_text`,
`payment_no_online_methods_text`.

4 ButtonTexts: `pm_enable` (فعال کردن), `pm_disable` (غیرفعال کردن),
`pm_settings` (تنظیمات), `pm_test` (تست اتصال).

## Security rules

- **Stable keys in callbacks**: `admin:fin:pm:*` routes carry the provider
  enum key (`[A-Z_]+`) — never display names — so renames can't break or
  redirect actions, and the routes sit behind the admin auth middleware.
- **Presence-only rendering**: config pages and `listManagedProviders()`
  emit `تنظیم شده/نشده` markers, never env values.
- **Provider+admin-id-only logging**: enable/disable logs exactly
  `{provider, adminId}` and connection tests `{provider, ok}` — no
  credentials, no provider payloads, no raw errors.
- **No side effects**: bootstrap/list/test never create payment rows; the
  Zarinpal probe is a dummy verify by design.

The test suite (`payment-provider-admin.test.ts`) locks all of the above:
route gating (source assertions), idempotent bootstrap, CAS
enable/disable + duplicate protection (including the virtual WALLET), user
visibility + the dormant-gateway empty state, secret hygiene in output and
logs, and both connection probes against a local mock server (including
HTML/unreachable-host failure persistence).
