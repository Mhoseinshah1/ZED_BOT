# ZED_BOT admin payment methods — card-to-card (Phase 21)

Phase 21 wires «مالی 💎» in the admin panel to a real finance section whose
job is configuring the **card-to-card** payment method: create/enable the
`CARD_TO_CARD` `PaymentGateway`, set its amount limits and instruction text,
and manage its encrypted `CardToCardAccount` rows. This is what fixes
«فعلاً روش پرداختی برای این مبلغ فعال نیست...» — those rows were never
seeded and had no admin UI, so Phase 7's (correct) selection logic had
nothing to offer.

Source: `apps/bot/src/services/admin-payment-method.service.ts`, flow in
`apps/bot/src/handlers/admin-finance/{admin-finance.handler,admin-finance-views}.ts`.
Pure configuration: **never** creates Payment/Order/CheckoutSession rows,
never touches receipt approval, checkout, provisioning or wallet payment.

## Admin flow

پنل مدیریت 🛠 → «مالی 💎» (`admin:finance`, previously a placeholder) →
«روش‌های پرداخت 💳» (`admin:finance:methods`) → «کارت‌به‌کارت 💳»
(`admin:finance:card`). The landing also links «رسیدهای تایید نشده 💵» to
the existing `admin:receipts` flow (nothing duplicated) and, since Phase
22, «تنظیمات پرداخت و کیف پول ⚙️» — the global wallet/payment settings
page (`docs/payment-wallet-settings-phase22.md`; the min/max there are the
GLOBAL top-up limits, separate from this page's per-gateway amounts). Everything is
behind `adminAuthMiddleware` + a `ctx.admin` re-check per route; short-id
targets resolve with `startsWith` and **ambiguous prefixes fail**.

| Callback | Action |
| --- | --- |
| `admin:finance:card` | 0 gateways → create prompt; 1 → its page; >1 → selection list (never merged/deleted automatically) |
| `admin:finance:card:add_gateway` | Creates THE gateway when missing (repeat clicks return the existing one) |
| `admin:finance:card:g:<gsid>` | Gateway page |
| `admin:finance:card:toggle_gateway:<gsid>` | isEnabled toggle |
| `admin:finance:card:min:<gsid>` / `max:<gsid>` | Amount-limit text flows |
| `admin:finance:card:instr:<gsid>` | Instruction-text flow |
| `admin:finance:card:accounts:<gsid>` | Card list |
| `admin:finance:card:add_account:<gsid>` | Add-card wizard |
| `admin:finance:card:account:toggle:<asid>[:yes]` | Card active/inactive (`:yes` confirms the last-active-card case) |
| `admin:finance:card:acc_confirm` / `acc_cancel` | Add-card confirmation |

## Gateway creation & settings

«ساخت روش کارت‌به‌کارت ✅» creates ONE gateway: type `CARD_TO_CARD`, name
«کارت‌به‌کارت», `isEnabled` true, `isHidden` false, min/max null,
`displayOrder` 1, `instructionText` null — **no card account is created
automatically and nothing is seeded**. The page shows name,
enabled/hidden, min/max («بدون محدودیت» when null), display order,
instruction text and active/total card counts, plus a warning when enabled
with zero active cards.

Settings flows (`admin_payment:min_amount` / `max_amount` / `instruction`):
limits accept a non-negative integer, `0` clears (null = no limit), Persian
digits accepted, and `min > max` is rejected with «حداقل مبلغ نمی‌تواند از
حداکثر مبلغ بیشتر باشد.» Instruction text is capped at 1000 chars; sending
«-» (or «حذف») clears it. It is appended to the user's Phase 7 card screen
as before.

## Card accounts

Add-card wizard: 16-digit card number (Persian/Arabic digits accepted,
spaces/dashes stripped; **no Luhn rejection** — a checksum guess must never
block a valid Iranian card) → owner name (2..100) → display order (0..9999,
empty = 0) → confirmation showing the **masked** number
(`6037 99** **** 4455`), owner, order and gateway → «تایید ثبت کارت ✅».
On confirm the number is encrypted with the existing `encryptSecret`
(APP_SECRET, AES-256-GCM) and stored as `cardNumberEncrypted`; the draft is
consumed before creating, so a double-clicked confirm cannot store twice.

The card list shows every account as `✅/⏸ masked | owner | order` — the
admin side **never renders the full number after entry** (only the paying
user's Phase 7 card screen decrypts it). Toggling the LAST active card off
warns «با غیرفعال کردن این کارت، ممکن است کارت‌به‌کارت برای کاربران نمایش
داده نمی‌شود.» and requires an explicit confirmation. **Delete is
deliberately NOT implemented**: `CardToCardAccount` has no `deletedAt`
column and payments reference accounts via `callbackPayload`, so
deactivation is the safe operation (no migration in this phase).

## How this fixes "no payment method"

Phase 7's `getAvailablePaymentMethods` already filtered on
isEnabled/isHidden/min/max/groups/paid-count — it just had no rows to find.
Phase 21 adds one integration refinement there: a `CARD_TO_CARD` gateway is
only offered when it has **at least one ACTIVE card account** (an empty
gateway would dead-end on the card screen). After the admin creates the
gateway and one active card: purchase, renewal, wallet top-up, extra
volume and extra time checkouts all show «کارت‌به‌کارت», and clicking it
shows the decrypted card + owner + amount + receipt-upload buttons exactly
as Phase 7 built it. Card rotation, receipt submission and review are
untouched.

## Security

Admin-only routes; card numbers encrypted at rest, never logged (logs carry
gateway/account ids only), never echoed raw by the admin UI (masked
everywhere, including the confirmation); session draft cleared on
landing/menu/cancel/completion and consumed before writes; ambiguous short
ids fail; admin configuration writes only PaymentGateway/CardToCardAccount
rows — verified in tests: zero Payment/Order/CheckoutSession rows.

## Testing

`apps/bot/tests/admin-payment-method.test.ts` (Vitest + disposable
PostgreSQL, `docs/testing.md`; runs in CI): pure helpers (normalization,
masking, limit/order parsing incl. Persian digits); gateway created exactly
once with correct defaults; min>max rejected and `0` clearing; card stored
encrypted and round-tripping through `decryptSecret`; checkout selection
sees the gateway with an active card and amount in range, hides it below
min/above max/with the only card deactivated/with the gateway disabled;
and no payment-side rows from any admin action.

## Phase 21.1 fixes

- The user card screen's «کپی شماره کارت»/«کپی مبلغ» became Telegram
  **`copy_text`** buttons (raw 16 digits / plain numeric amount copied
  client-side; no callback round-trip, no extra chat message). The legacy
  copy callbacks remain registered for old keyboards but only answer with
  a popup.
- Receipt submission now notifies every ACTIVE admin immediately: the
  receipt photo/document is forwarded by file_id (text receipts inline),
  captioned with type/amount/user/**masked** card + owner/payment +
  checkout short ids/date/status, plus «بررسی رسید 🧾» into the existing
  `admin:rec:view` page and «رسیدهای تایید نشده 💵». Sends are per-admin
  fault-isolated and a total failure only logs a warning — the submitted
  receipt is never rolled back. Opening the admin receipt detail also
  forwards the media (photo first, document fallback).

## Intentionally NOT implemented

Online gateways (Zarinpal/Plisio/NowPayments/AghayePardakht), Telegram
Stars, automatic receipt verification, receipt approval changes, card
delete (no `deletedAt` — deactivate instead), per-group gateway targeting
UI (`allowedGroups` stays whatever the DB holds), cashback/
activateAfterSuccessfulPaymentsCount editing, gateway hide/show per user,
seeding defaults, a log-group notification target (active admins are
messaged directly in this phase), Phase 22+.
