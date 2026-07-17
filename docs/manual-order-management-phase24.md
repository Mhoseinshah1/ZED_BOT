# ZED_BOT manual order management (Phase 24)

Phase 24 improves admin **visibility and navigation** for the Phase 23
manual OTHER_PRODUCT orders: status filters, a delivered-history list,
free-text search and a richer detail page. **Read-only additions** — the
only mutations remain the Phase 23 ones (info submission, reminder
counters, the atomic claim→send→finalize delivery), byte-for-byte
unchanged.

Source: `apps/bot/src/services/other-product-delivery.service.ts`
(`listManualOrders(filter, page)`, `searchManualOrders`,
`getManualOrderByShortId` — display paths now include the product's
category), handler in `apps/bot/src/handlers/admin-manual-orders/`.

## Admin path

پنل مدیریت 🛠 → «محصولات دیگر / سفارش‌های محصولات دیگر» → «سفارش‌های دستی
📦» — now a landing hub showing the four counters (در انتظار اطلاعات کاربر
/ آماده تحویل / تحویل‌شده / کل بازها) with buttons: «همه سفارش‌های باز»,
«در انتظار اطلاعات کاربر 📝», «آماده تحویل 📦», «تحویل‌شده ✅», «جستجوی
سفارش 🔎», «بازگشت به ادمین».

## Filters (`admin:mo:list:<filter>:<page>`)

| Filter | Statuses | Order |
| --- | --- | --- |
| `open` | WAITING_USER_INFO + WAITING_ADMIN_DELIVERY | createdAt desc |
| `info` | WAITING_USER_INFO | createdAt desc |
| `ready` | WAITING_ADMIN_DELIVERY | createdAt desc |
| `delivered` | DELIVERED (history) | deliveredAt desc (updatedAt/createdAt fallback) |
| `stock` *(specialized-workflows phase, additive)* | AWAITING_STOCK — paid stock orders parked for a refill | createdAt desc |

The `stock` filter surfaces as a conditional «در انتظار شارژ موجودی ⏳ (n)»
button on the other lists (and a landing counter) whenever parked orders
exist; the four original filters' semantics are untouched.

10/page; pagination preserves the filter. Rows:
`📝|📦|✅ مبلغ | محصول (كوتاه‌شده) | @کاربر | MM-DD` (delivered rows date
by deliveredAt). Old Phase 23 keyboards (`admin:mo:list:<page>`) stay
backward-compatible and map to `open`.

## Search

«جستجوی سفارش 🔎» → flow `admin_manual:search`, prompt «شناسه سفارش، آیدی
تلگرام کاربر، یوزرنیم یا نام محصول را وارد کنید.» (1..100 chars,
`/`-commands cancel). Matching, combined with OR:

- uuid-prefix-looking input → `OtherProductOrder.id` startsWith OR parent
  `Order.id` startsWith
- numeric input → exact `telegramId` (int64-bounded)
- text (leading `@` stripped) → username contains OR product name contains,
  both case-insensitive

Up to 10 results newest first; none → «نتیجه‌ای پیدا نشد.» The query is
kept in session so a detail page opened from results offers «بازگشت به
نتایج جستجو 🔎» (`admin:mo:search:again` re-runs it). Admin-only like the
whole section.

## Detail page

Now shows: manual-order short id AND parent Order short id + parent Order
status (پرداخت‌شده/تکمیل‌شده/…), delivery status, product + category,
amount, user (telegramId/username/name), paidAt, manual-order createdAt,
the required-info prompt + submitted info (when the product asks for it),
and — for delivered orders — deliveredAt, the delivering admin's short id
and the delivery text. Buttons stay state-gated: «تحویل سفارش 📦» only for
آماده تحویل, «پیام به کاربر برای تکمیل اطلاعات 📝» only for در انتظار
اطلاعات, nothing mutable for delivered. Back navigation: to the last
filter/page (stored in session) or to the search results when the detail
was opened from a search, plus «بازگشت به سفارش‌های دستی».

**Specialized-workflows additions** (see
`docs/specialized-product-workflows.md`): specialized records show the
frozen kind/profile labels and a customer-info **presence** line (values
never appear on lists/details); «مشاهده اطلاعات مشتری 🔒»
(`admin:mo:cinfo:<sid>`) opens the audited on-demand decryption viewer
(masked first, «نمایش کامل 🔓» = `admin:mo:cinfo_full:<sid>` separately
audited — every open writes an `AuditLog` row before anything is shown);
`PERSONALIZED_SERVICE` records offer «تکمیل بدون متن ✅»
(`admin:mo:deliver_done:<sid>`) on the delivery prompt. New status labels:
`AWAITING_STOCK` «در انتظار شارژ موجودی ⏳», `STOCK_RESERVED` «در حال تحویل
از موجودی 🎟».

## State cleanup

`clearManualOrderState` (used by the landing and `showAdminMenu`) now
clears the delivery flow/draft AND the search flow/query AND the stored
filter/page. Navigation routes (detail/remind/deliver/lists) use a narrower
internal cleanup that keeps the search query alive so «بازگشت به نتایج
جستجو» works; browsing a filter list replaces the search context.

## Testing

`apps/bot/tests/manual-order-management.test.ts`: each filter returns only
its statuses (subset-based — suites share the DB) with counters;
delivered history ordered by deliveredAt desc; search by manual short id,
parent-order short id, exact telegram id, @username (case-insensitive) and
product name, plus empty/too-long/no-match cases; detail carries category,
delivery text, deliveredByAdminId and the COMPLETED parent order; garbage
short ids fail; `initManualDelivery` output feeds the filters. (A true
ambiguous-uuid-prefix collision is impractical to fabricate; the
`take 2`-based ambiguity guard is unchanged from Phase 23.)

## Later phases

Phase 25 added **stock auto-delivery** for eligible products; manual orders
now also include its **fallback cases** — orders whose inventory was
exhausted or whose automatic send failed arrive here as
WAITING_ADMIN_DELIVERY with the usual admin notifications
(`docs/other-product-stock-phase25.md`). The landing additionally links
«مدیریت موجودی محصولات 🎟», where Phase 26 added safe cleanup of stuck
RESERVED stock items (release back to inventory / disable).

## Intentionally NOT implemented

Cancellation/refund/rejection, file delivery, wallet payment for
OTHER_PRODUCT, online gateways, Telegram Stars, reports/export, web panel,
mini app.
