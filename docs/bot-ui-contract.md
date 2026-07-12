# ZED_BOT UI contract

The agreed user/admin navigation contract as of **Corrective UI/UX Fix A**.
Changes to any layout below need an explicit new decision; tests in
`apps/bot/tests/corrective-fix-a.test.ts` lock the Fix A parts.

## Locked flows (never change without explicit instruction)

- «خرید اشتراک» opens the existing subscription purchase flow —
  `CB.USER_BUY` = `user:buy`, panel-first checkout.
- «محصولات دیگر» is a completely separate section —
  `CB.USER_OTHER_PRODUCTS` = `user:other_products`; OTHER_PRODUCT is never
  merged into the subscription purchase.
- Payment / order / provisioning / stock-delivery / wallet-mutation /
  renewal-mutation / receipt approval-rejection business logic.

## User main menu (13 visible buttons, unchanged by Fix A)

| row | buttons (ButtonText-backed) |
| --- | --- |
| 1 | خرید اشتراک 🔐 · تمدید سرویس ♻️ |
| 2 | سرویس‌های من 🛍 · کیف پول + شارژ 🏦 |
| 3 | زیرمجموعه گیری 👥 · اشتراک رایگان {تست} |
| 4 | گردونه شانس 🎲 · آموزش 📚 |
| 5 | پشتیبانی ☎️ · تعرفه اشتراک‌ها 💵 |
| 6 | درخواست نمایندگی 👨‍💼 · محصولات دیگر 🛍 |
| 7 | سفارش‌های من 🧾 |

## User wallet landing (Fix A)

Shows ONLY: Telegram numeric id, full name, username, phone number,
registration date, wallet balance, user group, total services,
unpaid/pending order count (`PENDING_PAYMENT`/`WAITING_RECEIPT`/
`PENDING_REVIEW`), referral count. Transaction lines render only inside
«تاریخچه تراکنش‌ها 📋».

Keyboard (exact):

| row | buttons |
| --- | --- |
| 1 | افزایش موجودی 💰 |
| 2 | تاریخچه تراکنش‌ها 📋 · بروزرسانی ♻️ |
| 3 | بازگشت به منوی اصلی |

Operator-editable MessageTemplate keys: `wallet_header_text`,
`wallet_topup_amount_prompt`, `wallet_topup_preview_note`,
`wallet_empty_transactions_text`. Dynamic amounts are always
formatted/escaped in code, and the template values themselves are
HTML-escaped at render time (these pages use parseMode HTML — a bad
operator edit must never make Telegram reject them). The Phase 22
Setting-backed top-up instruction and payment-page notice are separate and
NOT duplicated as templates.

## Service detail action order (Fix A)

1. بروزرسانی اطلاعات ♻️
2. لینک اشتراک 🔗 / کانفیگ‌ها 📄 (when stored)
3. تغییر لینک اشتراک 🔄 (when eligible)
4. تمدید سرویس ♻️ (when `canRenew`; emits `user:renew:svc:<sid>` — the
   existing renewal route, which re-validates eligibility on click)
5. خرید حجم اضافه ➕ / خرید زمان اضافه ⏳ (when eligible)
6. خاموش/روشن کردن سرویس (when eligible)
7. بازگشت به لیست
8. بازگشت به منوی اصلی

`canRenew` reuses `RENEWABLE_STATUSES` from the Phase 12 renewal service
(panel ACTIVE + status in ACTIVE/EXPIRED/LIMITED/DISABLED) — no duplicated
status rules.

## Admin main menu (Fix A, 5 rows)

| row | buttons |
| --- | --- |
| 1 | مالی 💎 · مدیریت کاربران 👤 |
| 2 | مدیریت محصولات/پلن‌ها · مدیریت پنل‌ها |
| 3 | محصولات دیگر / سفارش‌های محصولات دیگر |
| 4 | تیکت‌های پشتیبانی 🎫 · پیام همگانی 📣 |
| 5 | تنظیمات عمومی ⚙️ · گزارشات / بکاپ |

`CB.ADMIN_RECEIPTS` and the placeholder callbacks (panel features, bot
update, tutorials, mini-app settings, custom service price) stay registered
for old Telegram keyboards even though their buttons are not on the root.

## Admin finance landing (Fix A, 4 rows)

| row | buttons |
| --- | --- |
| 1 | رسیدهای تاییدنشده 💵 → `admin:receipts` |
| 2 | روش‌های پرداخت 💳 → `admin:finance:methods` · تنظیمات کیف پول و پرداخت 🏦 → `admin:finance:settings` |
| 3 | مدیریت کیف پول کاربران 👤 → `admin:users` (existing user-search entry; per-user wallet adjustments live on the admin user page) · گزارش مالی 📊 → `admin:fin:reports` |
| 4 | بازگشت به پنل ادمین → `admin:menu` |

## Back navigation

- Finance children (methods, settings, reports) → `FIN_CB.root`;
  finance root → `CB.ADMIN_MENU`.
- Wallet transaction list → `WALLET_CB.MAIN` (+ منو).
- Receipt pages keep their existing backs to `CB.ADMIN_MENU`
  (receipt submenus are locked; the finance landing is one tap away).
- Renewal plan selection keeps its existing back to the renewal list
  (`user:renew:list:1`) even when entered from the service detail —
  deliberate: a detail-aware back would need fragile session state.

## Deferred (documented, NOT implemented)

- Receipt-detail extra actions → Corrective Fix B.
- Service transfer, per-service user note, QR code on service detail.
- Detail-aware back from the renewal plan page.
