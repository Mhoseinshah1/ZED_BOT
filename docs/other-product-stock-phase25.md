# ZED_BOT other-product stock auto-delivery (Phase 25)

Phase 25 adds an **encrypted stock inventory** for OTHER_PRODUCT products
(gift-card codes, license keys, ready accounts, vouchers) and delivers one
item **automatically** right after payment approval. When stock is
unavailable or a send fails, the order falls back safely to the Phase 23
manual-delivery path. No Service rows, no panel calls, no refunds; the VPN
provisioning pipeline is untouched.

Source: `apps/bot/src/services/other-product-stock.service.ts`, admin UI in
`apps/bot/src/handlers/admin-stock/stock.handler.ts`, approval integration
in `admin-receipts/receipts.handler.ts`.

## Schema — one migration

The schema had `Product.deliveryType` (`STOCK_ITEM`) and
`Product.stockEnabled` but no inventory model, so migration
`20260710130944_other_product_stock` adds `enum StockItemStatus
{AVAILABLE, RESERVED, DELIVERED, DISABLED}` and `model
OtherProductStockItem` (productId, status, `contentEncrypted`, label?,
deliveredOrderId/ToUserId/At, disabledAt, createdByAdminId, timestamps,
indexes on productId/status/deliveredOrderId/createdAt) plus the Product
relation. The migration was unavoidable — nothing existing could hold
per-item encrypted content with claim/delivery state.

## Encryption / no raw logs

Content is encrypted with the existing `encryptSecret` (AES-256-GCM,
APP_SECRET) at creation and decrypted exactly once — for the buyer's
delivery message. It is **never logged** (logs carry item/order ids only),
and admins only ever see an 8-char masked preview (`CODE-123…`) in the
add-item confirmation; item lists show status/label/dates, never content.

## Admin path

پنل مدیریت 🛠 → «محصولات دیگر / سفارش‌های محصولات دیگر» → «سفارش‌های دستی
📦» → «مدیریت موجودی محصولات 🎟» (`admin:stock:products`; kept next to the
manual orders since both manage OTHER_PRODUCT fulfilment). Product list:
`🎟/📦 name | فعال/غیرفعال | موجود: N` (stock-eligible first). Product page:
deliveryType, تحویل استاک روشن/خاموش, available/delivered/disabled counters
plus an always-visible «رزروشده/گیرکرده» counter (Phase 26), the low-stock
threshold line and 🚨/⚠️ exhausted/low warnings (Phase 28:
`docs/other-product-stock-alerts-phase28.md`, which also adds post-delivery
admin alerts and list badges). Buttons: «افزودن آیتم موجودی ➕», «مشاهده
آیتم‌های موجودی», the `stockEnabled` toggle, «بازگشت».

## Add / list / disable

Add wizard (flows `admin_stock:content` → `admin_stock:label`): content
1..4000 chars → optional label («-» skips, ≤100) → confirmation showing the
product, label and the **masked preview only** → «تایید افزودن ✅» encrypts
and creates the item AVAILABLE with `createdByAdminId`. The draft is
consumed before creating (double-click safe); nothing is sent to any user
and no Payment/Order/CheckoutSession is written. Item list: 10/page,
`status | label | createdAt` (+deliveredAt/order short id when delivered;
RESERVED rows show the claiming order/user short ids), a disable button per
AVAILABLE item (AVAILABLE → DISABLED, status-guarded), Phase 26
release/disable buttons per RESERVED item (below), **no hard delete** —
delivered items are never actionable.

> **Phase 27:** «افزودن گروهی آیتم‌ها ➕➕» adds many items from one
> multiline message (one per line, max 100, in-batch dedupe, masked
> previews only) — see `docs/other-product-stock-bulk-phase27.md`.

## Auto-delivery lifecycle

`autoDeliverStockOrder(api, orderId)` runs from the receipt-approval
OTHER_PRODUCT branch, before the manual path:

1. Eligibility: PAID OTHER_PRODUCT whose product has
   `deliveryType = STOCK_ITEM` **or** `stockEnabled`, and
   `requiredUserInfoEnabled = false` (see below). Otherwise NOT_ELIGIBLE.
2. Idempotency: a COMPLETED order, or an item already DELIVERED for this
   order id, returns ALREADY_DELIVERED without sending.
3. **Atomic claim**: oldest AVAILABLE item first; CAS `updateMany`
   (AVAILABLE → RESERVED + this order/user id) with a few retries against
   racing orders — two orders can never hold the same item
   (test: concurrent orders over one item → exactly one delivery).
   No item → NO_STOCK.
4. Decrypt + send «سفارش شما آماده شد ✅» + product name + the full content
   in tap-to-copy `<code>` (HTML-escaped, never a file). An undecryptable
   item is auto-DISABLED and treated as NO_STOCK.
5. Send succeeded → one transaction: item RESERVED → DELIVERED
   (+deliveredAt) and Order PAID → COMPLETED (+completedAt); finalize
   retries once on DB failure and logs loudly after that. Send failed →
   the claim rolls back to AVAILABLE (scoped to our own order id, so a
   newer claim is never cleared) and SEND_FAILED is returned.

Crash-window note: a crash between claim and finalize leaves the item
RESERVED with this order's id; the next attempt **resumes that same item**
(never a second item, never another user's item) — the user could then
receive the same content twice, which is harmless for single-use codes and
documented here.

> **Phase 29:** buyers can re-open their completed stock orders under
> «سفارش‌های من 🧾» and view the delivered content again — decrypted only
> for the exact owner (`deliveredToUserId` + `deliveredOrderId` checks) —
> see `docs/user-other-product-orders-phase29.md`. Admin pages still never
> show content.

> **Specialized-workflows phase:** this lifecycle stays the pinned behavior
> for **GENERIC** products only. Specialized kinds (APPLE_ID / AI_ACCOUNT /
> TELEGRAM_PREMIUM / GIFT_CARD) use a separate reserve→send→finalize path
> (`reserveStockItemForOrder` + `runSpecializedStockDelivery`) that **never
> falls back to manual delivery** — an empty inventory parks the paid order
> as `AWAITING_STOCK` until the replenishment retry completes it.
> `OtherProductStockItem.deliveredOrderId` is now **UNIQUE** (one item per
> order AND one order per item, DB-enforced) and items gain an optional
> `contentFingerprint` (keyed HMAC) with a `(productId, contentFingerprint)`
> unique for decryption-free duplicate detection on bulk imports — legacy
> rows keep a null fingerprint and are invisible to dedup. See
> `docs/specialized-product-workflows.md`.

## Stuck RESERVED cleanup (Phase 26)

When no retry resolves a stuck claim, the item list offers two
admin actions per RESERVED item: «آزادسازی رزرو» (RESERVED → AVAILABLE,
claim fields cleared, content/label untouched — the item returns to
inventory) and «غیرفعال کردن رزرو» (RESERVED → DISABLED + `disabledAt`,
claim fields cleared). Both run a status-guarded `updateMany` and share a
safety check (`releaseReservedStockItem` / `disableReservedStockItem` in
the stock service): if `deliveredOrderId` points at a **COMPLETED** Order
the item is refused («این سفارش تکمیل شده و آیتم قابل آزادسازی نیست.») —
it was almost certainly delivered and only the finalize write was lost, so
releasing it could hand the same content to a second buyer. A PAID order
is actionable; a missing order is allowed with a warning log (ids only).
DELIVERED items stay immutable, AVAILABLE items report «این آیتم رزرو
نیست.», and content is never decrypted, logged or shown by these actions.
No Payment/Order/CheckoutSession row is touched and no user is notified.
Tests: `apps/bot/tests/other-product-stock-reserved.test.ts`.

## Fallback to manual delivery

- **NO_STOCK** → user gets «پرداخت تایید شد ✅ / موجودی خودکار این محصول
  فعلاً تمام شده است. / سفارش شما برای تحویل دستی ادمین ثبت شد.», the Phase
  23 `initManualDelivery` record is created, active admins are notified and
  the approving admin sees the ⚠️ exhausted-stock note (the stock page
  shows the same warning).
- **SEND_FAILED** → the user received nothing (send precedes finalize), so
  the manual fallback is safe: manual record + admin warning «تحویل خودکار
  ناموفق شد؛ سفارش برای تحویل دستی ثبت شد.»
- Successful auto-deliveries create **no** OtherProductOrder record — the
  stock item row (order/user/admin/date) is the history.
- Nothing is refunded automatically.

## requiredUserInfoEnabled behavior

Phase 25 takes the spec's safer option: products that require user info
**never auto-deliver** — they go through the unchanged Phase 23 flow (info
prompt → manual admin delivery), even when stock is enabled. Auto-delivery
after info submission is a possible later refinement (TODO).

## Wallet status

Wallet payment for OTHER_PRODUCT remains disabled (unchanged from Phase
23); card-to-card approval is the only trigger for auto-delivery.

## Testing

`apps/bot/tests/other-product-stock.test.ts`: encrypted storage
(ciphertext ≠ plaintext, round-trip), input validation, counters and
disable; oldest-first delivery with exactly one message containing the full
content, item DELIVERED + order COMPLETED, zero Service rows and zero
manual records on success, idempotent repeat; NO_STOCK leaves the order
PAID and disabled items are never delivered; failed send rolls the claim
back (fields cleared) and the same item delivers later; two concurrent
orders over one item → exactly one DELIVERED + one NO_STOCK with one send;
requiredUserInfoEnabled products return NOT_ELIGIBLE without touching
stock. Stable across repeated runs.

## Intentionally NOT implemented

File delivery, CSV/file import (multiline bulk add arrived in Phase 27:
`docs/other-product-stock-bulk-phase27.md`), hard delete, wallet payment for
OTHER_PRODUCT, refunds/cancellation, auto-delivery after required-info
submission (manual path instead — TODO), low-stock counter on the
manual-orders landing (per-product alerts arrived in Phase 28 instead:
`docs/other-product-stock-alerts-phase28.md`), online gateways, Telegram
Stars, reports/export, web panel, mini app, Phase 30+.
