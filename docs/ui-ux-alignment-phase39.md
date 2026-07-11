# ZED_BOT UI/UX alignment (Phase 39)

A text/layout alignment pass over the user and admin menus and the
DB-backed texts. **No business logic changed**: payments, orders, services,
provisioning, stock delivery, support and broadcast are untouched.

## Locked behavior (explicitly unchanged)

- **«خرید اشتراک» opens the existing subscription purchase flow**
  (`CB.USER_BUY` → `handlers/user-checkout`), panel-first as before — the
  accepted flow is locked as-is.
- **«محصولات دیگر» stays a separate main-menu section**
  (`CB.USER_OTHER_PRODUCTS`) — OTHER_PRODUCT was NOT merged into the
  subscription purchase; its checkout, post-payment required-info notice,
  manual/stock delivery and order separation are all unchanged.
- No Service rows for OTHER_PRODUCT; wallet/discount behavior in the
  pre-invoice unchanged.

## What was audited

`keyboards/user-main.keyboard.ts`, `keyboards/admin-main.keyboard.ts`,
`handlers/user-placeholders.handler.ts`,
`handlers/admin-placeholders.handler.ts`, `services/text.service.ts`,
`packages/database/src/seed.ts`, the checkout pre-invoice
(`user-checkout/checkout-views.ts`, read-only) and the user-facing empty
states.

## User main menu (final layout)

| row | buttons (ButtonText key → callback) |
| --- | --- |
| 1 | `buy_subscription` → `user:buy` · `renew_service` → `user:renew` |
| 2 | `my_services` → `user:services` · `wallet` → `user:wallet` |
| 3 | `other_products` → `user:other_products` · `my_orders` → `user:orders` |
| 4 | `support` → `user:support` |

Every label comes from a seeded, operator-editable `ButtonText` row
(editable in-bot since Phase 34).

**Hidden placeholders** (unfinished sections removed from the menu, not
deleted): `referral`, `free_test`, `lucky_wheel`, `tutorials`, `pricing`,
`representative_request`. None has a real handler yet, so per the
prefer-hiding rule they are no longer visible. Their callbacks stay
registered in `user-placeholders.handler.ts` so buttons on old Telegram
messages still answer with the placeholder page instead of dead-ending.
When a real flow lands, its button returns to the menu.

## Admin main menu (final layout)

| row | buttons |
| --- | --- |
| 1 | مالی 💎 · رسیدهای تایید نشده 💵 |
| 2 | مدیریت کاربران 👤 · تنظیمات عمومی ⚙️ |
| 3 | مدیریت محصولات/پلن‌ها · مدیریت پنل‌ها |
| 4 | محصولات دیگر / سفارش‌های محصولات دیگر |
| 5 | تیکت‌های پشتیبانی 🎫 · پیام همگانی 📣 |
| 6 | گزارشات / بکاپ |

All eleven visible sections are fully implemented modules. **Hidden admin
placeholders** (same old-keyboard-safe pattern): قابلیت‌های پنل 🛠, آپدیت
ربات 🆕, بخش آموزش 📚, تنظیمات مینی اپ ⚙️, قیمت سرویس دلخواه 🛰. No
callback constant was renamed or removed. Admin labels remain hardcoded
(not ButtonText-backed) — deferred deliberately: the admin menu is not
operator-facing copy.

## MessageTemplate keys added / used

Already existed: `start_text` (menu), `bot_off_text`, `support_text`
(ticket landing), `faq_text`. **Added (seeded + code fallback, wired):**

| key | used by | default |
| --- | --- | --- |
| `no_services_text` | «سرویس‌های من» empty state | شما هنوز سرویسی ندارید. |
| `no_orders_text` | «سفارش‌های محصولات دیگر» empty state | شما هنوز سفارشی ندارید. |
| `no_tickets_text` | «تیکت‌های من» empty state | هنوز تیکتی ثبت نکرده‌اید. |

None takes variables. Seeding stays create-if-missing — no duplicate rows,
operator edits never clobbered.

## ButtonText keys added / used

All seven visible menu buttons were already seeded (`my_orders` added in
Phase 34). **Added:** `next` («بعدی »») and `previous` («« قبلی») so the
full common set exists (`back`, `main_menu`, `cancel`, `confirm`, `next`,
`previous`).

## Hardcoded texts intentionally left for later (documented deferrals)

- **Pre-invoice text** (`preInvoiceText`) — heavily conditional (product
  type, panel, location, volume/duration, discount, wallet-balance notice,
  OTHER_PRODUCT required-info notice) with per-field HTML escaping;
  flattening it into one template in this pass would risk the locked
  checkout rendering. Deferred with this note instead of a half-wired key
  (an editable-but-ignored template row would mislead operators).
- **Receipt upload instruction / payment page texts** — the payment-page
  notice and wallet top-up instruction are already operator-editable via
  the Phase 22 `Setting` keys (`payment.*`, `wallet.topup.*`); NOT
  duplicated into MessageTemplate.
- **Pagination labels** («بعدی »/« قبلی» across ~10 handlers) — the
  ButtonText keys now exist; swapping every hardcoded pagination label for
  an async lookup is mechanical follow-up work.
- Success/delivery texts, service-detail header, unified-history and
  payment-list empty states — unchanged literals for now.

## Tests

`apps/bot/tests/ui-alignment.test.ts`: user-menu structure (exact
label/callback order, «خرید اشتراک» → `CB.USER_BUY`, «محصولات دیگر» →
`CB.USER_OTHER_PRODUCTS`, all six hidden placeholder callbacks absent);
admin-menu structure (all implemented sections present, all five hidden
placeholder callbacks absent); ButtonText fallbacks for every visible
button plus the six common keys; MessageTemplate fallbacks for the
important keys; the pre-invoice still rendering every required field for
both product types (incl. discount lines and the OTHER_PRODUCT
required-info notice) from a fixture; the checkout handler still owning
`CB.USER_BUY`; seed key uniqueness; and this doc's lock statements.
