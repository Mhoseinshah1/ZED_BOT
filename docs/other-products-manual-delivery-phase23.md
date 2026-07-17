# ZED_BOT other products — manual admin delivery (Phase 23)

Phase 23 completes the OTHER_PRODUCT lifecycle: after payment the order
becomes a real manual-delivery order, the user is asked for required info
when the product needs it, admins see pending orders under «سفارش‌های دستی
📦» and deliver text/codes/instructions; the user receives the delivery and
the order completes. **No Service row, no panel call, no provisioning** —
OTHER_PRODUCT is text-delivered by a human.

Source: `apps/bot/src/services/other-product-delivery.service.ts`, user
intake in `apps/bot/src/handlers/user-other-products/`, admin flow in
`apps/bot/src/handlers/admin-manual-orders/`, approval integration in
`admin-receipts/receipts.handler.ts`.

## Schema strategy — no migration

The schema already had the full `OtherProductOrder` model
(`orderId @unique`, `status` with `WAITING_USER_INFO` /
`WAITING_ADMIN_DELIVERY` / `DELIVERED`, `userProvidedInfoText`,
`adminDeliveryText`, `deliveredByAdminId`, `deliveredAt`, reminder
counters), so Phase 23 uses it as-is. The parent `Order` stays `PAID` until
delivery and becomes `COMPLETED` (+`completedAt`) when delivered. Statuses
CANCELLED/REFUNDED/… exist in the enum but are intentionally unused (no
cancellation/refund flow in this phase).

## Lifecycle

1. User buys an OTHER_PRODUCT through the existing Phase 6/7 checkout and
   pays card-to-card; the Phase 8 receipt review approves and creates the
   PAID Order (unchanged).
2. **Phase 23:** approval now calls `initManualDelivery(orderId)` —
   idempotent (unique `orderId`; a repeated approval or concurrent init
   returns the existing record):
   - `product.requiredUserInfoEnabled` → record `WAITING_USER_INFO`; the
     user gets «رسید پرداخت شما تایید شد ✅» + «برای تکمیل سفارش، اطلاعات
     زیر را ارسال کنید:» + the product's `requiredUserInfoPromptText` and a
     «تکمیل اطلاعات سفارش 📝» button (`user:op:info:<orderSid>` — the
     resume path if they miss it; admins can also re-send it).
   - otherwise → `WAITING_ADMIN_DELIVERY`; the user gets «سفارش شما ثبت شد
     و در انتظار تحویل توسط ادمین است.» and active admins are notified
     («سفارش دستی جدید 📦» with a «مشاهده سفارش 📦» button — same
     fault-isolated pattern as receipt notifications).
3. Info flow (`other_product:info`): text only, 1..2000 chars, `/`-commands
   cancel (the button resumes). Stored via a status-guarded `updateMany`
   (`WAITING_USER_INFO → WAITING_ADMIN_DELIVERY`), so a double submit can
   never overwrite info that already moved the order forward. On success:
   «اطلاعات سفارش ثبت شد ✅ / سفارش شما در انتظار تحویل توسط ادمین است.» +
   admin notification.
4. Admin delivery (below) → user receives «سفارش شما آماده شد ✅» with the
   product name + delivery text → record `DELIVERED`, Order `COMPLETED`.

## Admin path

پنل مدیریت 🛠 → «محصولات دیگر / سفارش‌های محصولات دیگر» (the existing
`admin:other_products` button, previously a placeholder) → «سفارش‌های دستی
📦». List: status counters (در انتظار اطلاعات کاربر / آماده تحویل /
تحویل‌شده) + open orders newest-first, 10/page, labeled
`📝|📦 مبلغ | محصول | کاربر | تاریخ`. Detail (`admin:mo:view:<sid>`, 8-char
`OtherProductOrder` id prefix, ambiguous fails): order short id, status,
product, amount, user (telegramId/username/name), paidAt, required-info
prompt + submitted info, and delivery text/time once delivered. Buttons:
«تحویل سفارش 📦» (only when آماده تحویل), «پیام به کاربر برای تکمیل اطلاعات
📝» (only when منتظر اطلاعات — re-sends the prompt+button and bumps the
schema's reminder counters), «بازگشت».

> **Phase 25 update:** stock-eligible products (`deliveryType STOCK_ITEM`
> or `stockEnabled`, without required user info) now **auto-deliver** from
> an encrypted inventory right after approval; exhausted stock or a failed
> send falls back to THIS manual path with explicit user/admin notices —
> see `docs/other-product-stock-phase25.md`.

> **Phase 24 update:** the section became a landing hub with status
> filters (open / waiting-info / ready / delivered history sorted by
> deliveredAt), free-text search (order/manual short id, telegram id,
> username, product name) and a richer detail page (both short ids, parent
> Order status, category, delivering admin) — see
> `docs/manual-order-management-phase24.md`. Delivery mutation semantics
> here are unchanged.

> **Phase 29 update:** users can now track these manual orders themselves
> under «سفارش‌های من 🧾» — status, required-info resume (the same
> `user:op:info` callback) and the delivered text — see
> `docs/user-other-product-orders-phase29.md`. Read-only; nothing in this
> flow changed.

> **Specialized-workflows update:** this init/delivery pipeline stays the
> pinned path for **GENERIC** products; specialized kinds create their
> `OtherProductOrder` through the specialized engine (same unique
> `orderId`, plus frozen kind/profile/schema/completion snapshots) and can
> collect a **structured, encrypted** customer-input form instead of the
> free-text prompt. Additive changes to THIS flow: `deliverManualOrder`
> accepts a **null delivery text only for `PERSONALIZED_SERVICE` records**
> («تکمیل بدون متن ✅» — the buyer receives «انجام شد ✅»), a frozen
> `completionMessageSnapshot` is sent after any successful delivery
> (best-effort), and `submitUserInfo` stamps
> `fulfillmentAdminsNotifiedAt` inside its status flip so the specialized
> dispatch can never send a second "ready" notice. See
> `docs/specialized-product-workflows.md`.

## Delivery flow

«تحویل سفارش 📦» → flow `admin_manual:deliver_text` asks «متن تحویل سفارش
را وارد کنید.» (1..4000 chars, `/`-commands cancel) → confirmation with
order/product/user and a preview → «تایید و ارسال به کاربر ✅». On confirm
(the draft is consumed FIRST, so a double-clicked confirm cannot deliver
twice), delivery runs as **claim → send → finalize**:

1. **Atomic claim before sending**: a CAS `updateMany` requires status
   `WAITING_ADMIN_DELIVERY` AND `adminDeliveryText`/`deliveredByAdminId`/
   `deliveredAt` all still null, and writes the delivery text + admin id.
   Two concurrent admins can never both claim — the loser returns a safe
   message («این سفارش قبلاً تحویل شده است.» when delivered, otherwise the
   not-ready notice) **without sending**, so the user can never receive the
   same delivery twice (test: `Promise.all` double delivery → exactly one
   message).
2. **Send** «سفارش شما آماده شد ✅» + product + delivery text — only the
   claim winner reaches this step.
3. **Finalize**: status → `DELIVERED` + `deliveredAt`, Order → `COMPLETED`.
   A failed send instead **rolls back only our own claim** (the rollback
   `where` repeats the exact claimed values, so a newer claim made after
   the rollback window can never be cleared) and reports «ارسال پیام به
   کاربر ناموفق بود؛ سفارش تحویل‌خورده نشد.» — the record stays fully
   deliverable (test-verified, including a successful redelivery).

Known limitation: a process crash between claim and finalize/rollback
leaves a stale claim that blocks delivery until resolved manually (logged
loudly if rollback itself fails); the window is a single Telegram send.

## Wallet integration status

**Not enabled for OTHER_PRODUCT** (allowed as optional by the phase spec):
the Phase 15 wallet button and `payPurchaseDraftWithWallet` remain
SERVICE_PRODUCT-only, so card-to-card is the OTHER_PRODUCT payment path.
Enabling it later only requires the same manual-delivery init after the
wallet transaction — documented TODO, nothing blocks it.

## Security

Admin-only admin routes; the info button/flow is owner-scoped on every
step (foreign/ambiguous short ids fail); text lengths validated; no
payment/order/wallet mutation beyond the delivery status transitions and
`Order → COMPLETED`; internal errors never reach users; logs carry ids and
safe messages only (no delivery/info payloads).

## Testing

`apps/bot/tests/other-product-delivery.test.ts` (Vitest + disposable
PostgreSQL): init routes info/no-info products to the right status,
idempotent double init, zero Service rows; owner-scoped resume lookup,
info length/foreign/double-submit rejection, trimmed storage + single
transition; delivery sends the correct message and marks
DELIVERED/COMPLETED with admin/time/text; double delivery refused without a
second send; failed send leaves everything untouched and the order
listed/deliverable. Handler dispatch (approval branch, Telegram flows) is
covered by code review — no grammY harness.

## Intentionally NOT implemented

STOCK_ITEM auto-delivery (arrived in Phase 25:
`docs/other-product-stock-phase25.md`), file delivery (`userProvidedFiles`/
`adminDeliveryFiles` stay unused), cancellation/rejection/refund flows
(enum values reserved), wallet payment for OTHER_PRODUCT (TODO above),
online gateways, Telegram Stars, order-history pages, advanced reports,
web panel, mini app, Phase 24+.
