# ZED_BOT low-stock alerts (Phase 28)

Phase 28 adds **operational visibility** to the Phase 25–27 stock inventory:
a per-product low-stock threshold, warning badges in the stock admin UI, and
active-admin alerts fired right after an auto-delivery leaves a product low
or empty. Read-and-notify only — payment/receipt/order and auto-delivery
mutation logic are untouched, no Service rows, no user notifications, no
stock content in any alert.

Source: threshold/alert functions in
`apps/bot/src/services/other-product-stock.service.ts` (plus a small
`deleteSetting` helper in `settings.service.ts`), UI in
`apps/bot/src/handlers/admin-stock/stock.handler.ts`, post-delivery hook in
`admin-receipts/receipts.handler.ts`. **No migration.**

## Setting key / defaults

`stock.low_threshold.<productId>` in the existing `Setting` model (type
NUMBER, 30s-TTL cache like all settings):

- **missing / null** — no low threshold; the out-of-stock alert still fires
  for stock-enabled products.
- **0** — alert only when available reaches zero.
- **N > 0 (≤ 100000)** — alert when available ≤ N.

`getStockLowThreshold` / `setStockLowThreshold(productId, n | null)` read
and write it; clearing deletes the row.

## Admin path / threshold UI

پنل مدیریت 🛠 → «محصولات دیگر / سفارش‌های محصولات دیگر» → «مدیریت موجودی
محصولات 🎟» → انتخاب محصول. The product page now also shows «حد هشدار
کمبود: تنظیم نشده / فقط صفر / ≤ N» and the buttons «تنظیم هشدار کمبود
موجودی 🔔» (`admin:stock:threshold:<sid>`, flow `admin_stock:threshold`)
and — only while a threshold is set — «حذف هشدار کمبود موجودی»
(`admin:stock:threshold_clear:<sid>`). The prompt accepts an integer
0..100000 (Persian/Arabic digits normalized) or «-» to clear; invalid input
re-prompts with a safe message. `clearAdminStockState` clears the flow and
draft like the other stock wizards.

## Product list / page warnings

List rows get a badge: `🚨` stock-eligible and available = 0, `⚠️`
threshold set and available ≤ threshold, `🎟` healthy stock-eligible, `📦`
manual product — plus `| حد: N` when a threshold is set. The product page
shows «🚨 موجودی تمام شده است.» (with «سفارش‌های جدید به تحویل دستی
می‌روند.» for stock-enabled products) or «⚠️ موجودی کم است.» under the
counters.

## Alert behavior

`evaluateStockAlert(productId)` → `{level: none|low|out, available,
threshold}` with the rule above (out wins over low).
`notifyAdminsAboutStockAlert(api, {productId, orderId?})` evaluates, and on
low/out sends every ACTIVE admin:

- title «🚨 موجودی محصول تمام شد» or «⚠️ موجودی محصول کم است»
- product name, «موجودی فعلی: N», «حد هشدار: فقط صفر / ≤ N» (when set),
  «سفارش: <8-char id>» (when triggered by a delivery)
- buttons «مدیریت موجودی محصول 🎟» (`admin:stock:p:<sid>`) and «افزودن
  گروهی آیتم‌ها ➕➕» (`admin:stock:bulk_add:<sid>`) — the Phase 27 bulk add
  is the intended refill path.

Sends are fault-isolated per admin (one blocked admin never stops the
rest), the function never throws, and it returns how many admins were
reached. A notification failure is logged with ids only and **never rolls
back** the delivery/payment/order.

**Hook:** the receipt-approval OTHER_PRODUCT branch calls it right after a
**fresh** successful auto-delivery (`DELIVERED`); idempotent
`ALREADY_DELIVERED` repeats don't re-alert because the count didn't change.
The NO_STOCK fallback keeps its existing manual-delivery notifications, with
the approving admin's summary sharpened to «🚨 موجودی محصول تمام شده و
سفارش برای تحویل دستی ثبت شد.»

## Duplicate alerts

Deliberately simple for Phase 28: the alert fires after **every** successful
auto-delivery while the condition holds (no crossing-detection, no
cool-down). Acceptable because there are no scheduled jobs and stock volume
is low; a crossing-only rule is a possible later refinement (TODO).

## Security

Admin-only UI; alerts carry product name, counts, ids and buttons — never
stock content, never the buyer's delivery message; logs carry ids only; no
user notification; no financial/order/provisioning mutation anywhere in
this phase.

## Testing

`apps/bot/tests/other-product-stock-alerts.test.ts`: pure
`parseThresholdInput` / `stockAlertLevel` suites (Persian/Arabic digits,
«-», decimals/negatives/over-range rejected; the spec's threshold matrix:
null → none/out, 0 → none/out, 5 → none/low/out); set/clear persisting
through the `Setting` row; `evaluateStockAlert` levels against a real
product; `notifyAdminsAboutStockAlert` reaching active-but-not-inactive
admins with product name/count/threshold/order short id and both management
buttons, one failing admin not blocking the rest, level none sending
nothing; and an end-to-end check that delivering the last item via
`autoDeliverStockOrder` then evaluating/notifying produces the 🚨 alert
without any stock content in it.

## Intentionally NOT implemented

Crossing-only/cool-down alert dedup (TODO above), reports/export, scheduled
jobs, email/Slack notifications, CSV/file import, refunds/cancellation,
wallet payment for OTHER_PRODUCT, online gateways, Telegram Stars, web
panel, mini app, Phase 29+.
