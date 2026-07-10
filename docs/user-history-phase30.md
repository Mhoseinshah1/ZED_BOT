# ZED_BOT user general history (Phase 30)

Phase 30 turns «سفارش‌های من 🧾» into a **read-only general history hub**:
one place for every order type (service purchase / renewal / extra volume /
extra time / other products), wallet top-ups, and payment attempts —
card-to-card and wallet — with pending/approved/rejected states. Strictly
read-and-render: no Payment/Order/Wallet/Service/Stock mutation, no Service
rows, no migration.

Source: `apps/bot/src/services/user-history.service.ts`, UI in
`apps/bot/src/handlers/user-orders/orders.handler.ts` (same composer as
Phase 29).

## Hub

`CB.USER_ORDERS` (`user:orders`, the main-menu button) now opens the hub
«سفارش‌ها و سوابق من 🧾» (alias callback `user:hist`):

1. «همه سوابق 🧾» → `user:hist:list:1` — the unified list
2. «محصولات دیگر 🛍» → `user:orders:list:1` — the unchanged Phase 29 list
3. «پرداخت‌ها 💳» → `user:payhist:list:1` — payment history
4. «کیف پول 🏦» → the existing wallet page (`user:wallet`; wallet
   transaction history stays in the wallet area)
5. «بازگشت به منو»

## Unified list (`user:hist:list:<page>`)

Merges two owner-scoped sources, newest first
(`paidAt ?? completedAt ?? createdAt`), 10/page:

- **Orders** — every `OrderType`; the title is the type label plus the
  product-name snapshot when present.
- **Order-less payments** — pending/rejected card-to-card attempts and
  wallet top-ups (`orderId = null`). **Duplicate rule:** both approval paths
  stamp `Payment.orderId` when the Order is created, so an approved order
  payment is represented by its Order row only; its payment stays reachable
  from the order detail.

Rows: `✅|⏳|❌ title | amount | MM-DD` (✅ completed/approved, ⏳
pending/paid/in-review/provisioning, ❌ failed/rejected/cancelled/refunded/
expired). Order rows open `user:hist:view:o:<orderSid>`, payment rows open
`user:hist:view:p:<paymentSid>` (same renderer as the payment history
detail). All callbacks are far below 64 bytes.

## Order detail (`user:hist:view:o:<sid>`)

Short order id (the only id shown), type label, status label, product name
(snapshot first, live product fallback), amount, created/paid/completed
dates, and — when a primary payment is linked — the payment method
(«کارت‌به‌کارت» / «کیف پول») and payment status. Buttons appear only when
they apply: «مشاهده سرویس 🛍» (`user:svc:view:<serviceSid>`, the existing
owner-scoped service detail) when the order has a Service, «مشاهده جزئیات
محصول دیگر 🛍» (`user:orders:view:<orderSid>`, the Phase 29 detail — the
ONLY place delivered stock content / manual text is shown) for
OTHER_PRODUCT, «مشاهده پرداخت 💳» when a payment is linked.
Failed/cancelled/refunded orders show their status with no action. No raw
adapter errors, no admin notes, no encrypted stock content here.

## Payment history (`user:payhist:list:<page>`, detail `user:payhist:view:<sid>`)

ALL of the user's payment attempts newest first, 10/page — pending review,
approved, rejected, expired — including wallet top-ups and wallet payments.
Detail: payment short id, purpose («شارژ کیف پول» / «پرداخت سفارش» /
«پرداخت با کیف پول»), status, amount, method, created/reviewed dates, a
receipt-uploaded flag («رسید: ارسال شده ✅» / «—» — the media itself is
never re-sent), the related order (type + short id + «مشاهده سفارش 🧾»
button) when linked, and the admin's rejection reason for rejected payments
(already user-communicated at rejection time). Approved wallet top-ups get
a «مشاهده کیف پول 🏦» button.

## Owner scope / security

Every list/detail query filters on `userId = ctx.dbUser.id`; short-id
resolution uses `take: 2` and fails on anything but exactly one match.
Full UUIDs, other users' records, admin notes, raw adapter errors, receipt
media and encrypted stock content are never exposed — the general history
service never even selects stock items. Read-only end to end.

## Relationship to Phase 29

Phase 29 functions, callbacks (`user:orders:list:<page>`,
`user:orders:view:<sid>`) and behavior are untouched — old keyboards keep
working; only the `user:orders` entry now renders the hub, and the Phase 29
list is titled «سفارش‌های محصولات دیگر 🛍» with a back-to-hub button. See
`docs/user-other-product-orders-phase29.md`.

## Testing

`apps/bot/tests/user-history.test.ts`: unified list containing all five
order types plus an order-less wallet top-up; exclusion of other users'
rows and of payments that belong to an order (no duplicates); newest-first
merged sorting across sources; owner-scoped order detail with
garbage-short-id and foreign-user failures; payment history carrying
pending/approved/rejected states with gateway/receipt data; owner-scoped
payment detail; order-linked payment exposing the related order; no stock
plaintext anywhere in general-history output for a stock-delivered order;
merged pagination at 10/page with clamping.

## Intentionally NOT implemented

Cancellation/refund requests, support ticketing, invoice PDF, export,
receipt media re-send, wallet-transaction list inside the hub (stays in the
wallet area), online gateways, Telegram Stars, admin reports, web panel,
mini app, Phase 31+.
