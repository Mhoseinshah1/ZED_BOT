# Corrective UI/UX Fix D

Real source-code changes: the user support/ticket navigation, the
orders/history landing with its five read-only lists, same-page back
navigation, and operator-editable support/history texts. Implemented
BEFORE the final production audit (the audit was re-run afterwards).

**Locked and untouched:** `CB.USER_BUY`, the panel-first subscription
checkout, `CB.USER_OTHER_PRODUCTS` and the SERVICE/OTHER separation, the
Fix A wallet landing, direct renewal, the admin finance tree, Fix B
receipts/OTHER_PRODUCT/stock, Fix C users/products/panels, every
payment/order/wallet/provisioning mutation, production scripts. No schema
migration.

## Support («پشتیبانی 🎫»)

Landing rows: ایجاد تیکت جدید ➕ / تیکت‌های من 📋 / بازگشت به منوی اصلی —
labels ButtonText-backed (`new_ticket`, `my_tickets`), body from the
`support_landing_text` MessageTemplate (default: «از این بخش می‌توانید با
پشتیبانی در ارتباط باشید و پاسخ تیکت‌های قبلی را پیگیری کنید.»).

Flow texts are templates rendered with the real validation limits
(`{min}`/`{max}` substituted in code): `support_subject_prompt`,
`support_message_prompt`, `support_reply_prompt`,
`support_ticket_created_text`; the empty list uses
`support_empty_tickets_text` (supersedes `no_tickets_text` on that page —
both stay seeded).

Ticket detail — open: پاسخ به تیکت ✍️ / بروزرسانی ♻️ (re-reads
messages/status) / بازگشت به تیکت‌های من (SAME list page, via the
`userTicketListPage` session context) / بازگشت به پشتیبانی. Closed: no
reply button — refresh and backs only. Owner scope, transitions and
notifications unchanged (Phase 32 rules); pagination uses the
`next`/`previous` ButtonTexts.

## History («سفارش‌های من 🧾»)

Landing (title + `history_landing_text` template):

| row | button → destination |
| --- | --- |
| 1 | همه سفارش‌ها 📋 → `user:hist:list:1` (Phase 30 unified list) |
| 2 | خرید اشتراک‌ها 🔐 → `user:hist:sub:1` (new subscription filter) · محصولات دیگر 🛍 → `user:orders:list:1` (Phase 29 list) |
| 3 | پرداخت‌ها 💳 → `user:payhist:list:1` · تراکنش‌های کیف پول 🏦 → `user:hist:wtx:1` (new) |
| 4 | بازگشت به منوی اصلی |

All read-only, owner-scoped, 10/page, newest first:

- **همه سفارش‌ها** — the Phase 30 unified list; the dedup rule is
  unchanged and test-locked: a payment with an `orderId` is represented by
  its ORDER (no duplicate row), wallet top-ups appear exactly once.
- **خرید اشتراک‌ها** — new `listUserSubscriptionOrders` over
  `SUBSCRIPTION_ORDER_TYPES` (purchase/renewal/extra volume/extra
  time/location change); rows open the existing order detail. OTHER_PRODUCT
  is deliberately excluded (locked separation).
- **پرداخت‌ها** — Phase 30 list; empty state now `no_payments_text`.
- **تراکنش‌های کیف پول** — the same read-only data as the wallet page via
  a NEW `user:hist:wtx:<page>` route whose backs return to the history
  landing; the wallet's own `user:wallet:tx` route keeps returning to the
  wallet landing (source-correct backs, no session flag needed).
- **محصولات دیگر** — unchanged Phase 29 list; empty state now
  `no_other_product_orders_text`.

Back navigation: order details return to the same list (all/subscription)
and page (`userHistListKind`/`userHistListPage`); payment details return
to the same payment page (`userPayListPage`); every list ends with
بازگشت به سوابق (`back_to_history` ButtonText) + بازگشت به منوی اصلی. No
metadata JSON, file ids or secrets render anywhere (receipts appear only
as a sent/not-sent marker).

## New text keys

MessageTemplates (create-if-missing, code fallbacks):
`support_landing_text`, `support_subject_prompt`,
`support_message_prompt`, `support_reply_prompt`,
`support_empty_tickets_text`, `support_ticket_created_text`,
`history_landing_text`, `no_payments_text`,
`no_other_product_orders_text`.

ButtonTexts: `new_ticket`, `my_tickets`, `reply_ticket`, `refresh`,
`all_orders`, `subscription_orders`, `other_product_orders`, `payments`,
`wallet_transactions`, `back_to_support`, `back_to_history`
(+ pre-existing `next`/`previous`, now wired into the support/history
pagination). No duplicated seed rows.

## Tests

`apps/bot/tests/corrective-fix-d.test.ts` (10 tests): exact support and
history landing rows + labels, template usage locks, open/closed ticket
keyboards with same-page returns, owner-scope + page-context locks,
source-correct wallet-history backs, no-file-id/secret locks, all key
fallbacks + seeds + `{min}`/`{max}` rendering, locked CB constants, and
DB tests for the unified-history dedup (order payment absent, top-up once)
and the owner-scoped subscription filter. One assertion in
`user-menu-placeholders.test.ts` updated for the superseded tickets
empty-state key.
