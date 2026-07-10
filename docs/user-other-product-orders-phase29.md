# ZED_BOT user order history for OTHER_PRODUCT (Phase 29)

Phase 29 adds a **read-only user-facing** «سفارش‌های من 🧾» section: users
list and track their own OTHER_PRODUCT orders, resume the required-info
flow, and re-read what was delivered — the manual admin text or the
auto-delivered stock content. Nothing here mutates payments, orders,
deliveries or stock; no Service rows; SERVICE_PRODUCT orders are not
included (no generic order history existed before this phase).

Source: `apps/bot/src/services/user-other-product-orders.service.ts`,
handler `apps/bot/src/handlers/user-orders/orders.handler.ts`, button in
`keyboards/user-main.keyboard.ts` (ButtonText key `my_orders`, fallback
«سفارش‌های من 🧾»). No migration.

## User path

منوی اصلی → **«سفارش‌های من 🧾»** (`user:orders`) → list 10/page
(`user:orders:list:<page>`) → detail (`user:orders:view:<orderSid>`). All
routes sit behind the normal user gates and are scoped to
`ctx.dbUser.id`; ambiguous short ids fail (take-2 rule).

## Order sources

One list covers all three OTHER_PRODUCT fulfilment shapes:

- **A — manual path (Phase 23):** the `OtherProductOrder` record drives the
  status: در انتظار اطلاعات شما 📝 / در انتظار تحویل ادمین ⏳ /
  تحویل‌شده ✅ / بسته‌شده ❌ (CANCELLED/REFUNDED enum values, read-only —
  no cancellation flow exists).
- **B — stock auto-delivery (Phase 25):** no OtherProductOrder exists; the
  DELIVERED `OtherProductStockItem` with `deliveredOrderId = order.id` marks
  the order تحویل‌شده (خودکار) ✅.
- **C — paid-but-not-initialized edge:** a PAID order with neither record
  shows «در حال آماده‌سازی ⏳».

Rows: `📝|⏳|✅|❌ product | amount | MM-DD` (paidAt, falling back to
createdAt), newest first. Product names come from
`productNameSnapshot` first, so a later-deleted Product still displays.

## Detail

Order short id (the only id ever shown), product, amount, status, created /
paid / completed dates, the product's required-info prompt and the user's
submitted info when present, plus per-status content:

- **waiting info** — explanation + «تکمیل اطلاعات سفارش 📝» with the exact
  Phase 23 callback `user:op:info:<orderSid>` (parent-Order short id), so
  submission logic is reused, not duplicated.
- **waiting delivery** — «سفارش شما در انتظار تحویل ادمین است.»
- **manual delivered** — the admin's delivery text in a copyable
  HTML-escaped `<code>` block.
- **stock delivered** — «تحویل خودکار:» + the decrypted content in
  `<code>` (see security below).
- **pending** — «سفارش در حال آماده‌سازی است.»

Buttons: the info-resume button when applicable, «بازگشت به سفارش‌ها»,
«بازگشت به منو». All dynamic text is HTML-escaped.

## Delivered-content visibility

- **Manual text** (`visibleManualDeliveryText`): shown only when the manual
  record belongs to the current user, its status is DELIVERED and
  `adminDeliveryText` is non-empty.
- **Stock content** (`getDeliveredStockContentForUser`): users may re-open
  their completed auto-delivered orders and see the content again. It is
  decrypted **only after every check passes**: the Order belongs to the
  current user AND `stockItem.status = DELIVERED` AND
  `stockItem.deliveredOrderId = order.id` AND
  `stockItem.deliveredToUserId = current user.id`. A decrypt failure shows
  «محتوای تحویل قابل نمایش نیست. لطفاً با پشتیبانی تماس بگیرید.» and logs
  ids only. Admin-facing pages still never show stock content, and nothing
  raw is ever logged.

## Testing

`apps/bot/tests/user-other-product-orders.test.ts`: list scoping (only the
current user's OTHER_PRODUCT orders — other users' and SERVICE_PURCHASE
orders excluded); waiting-info / waiting-delivery / delivered manual rows
with the derived status and delivery-text visibility rules; the stock
auto-delivered order appearing with no OtherProductOrder and its content
decrypting only for the matching `deliveredToUserId`; a foreign user
getting null from the detail lookup and no content from the decrypt helper;
the PAID no-record edge deriving «pending»; pagination at 10/page; garbage
short ids failing; decrypt failure returning the safe message without
content.

## Intentionally NOT implemented

Cancellation/refund/rejection, support ticketing, stock export, file
delivery, wallet payment for OTHER_PRODUCT, online gateways, Telegram
Stars, SERVICE_PRODUCT rows in this history, web panel, mini app,
Phase 30+.
