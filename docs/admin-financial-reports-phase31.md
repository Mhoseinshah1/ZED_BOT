# ZED_BOT admin financial reports (Phase 31)

Phase 31 adds **admin-only, read-only** operational reporting: a ranged
financial dashboard, latest-payments and latest-orders lists, and detail
pages that link into the existing receipt-review and manual-order screens.
No financial row is mutated, no Service rows are created, no migration.

Source: `apps/bot/src/services/admin-financial-report.service.ts`, UI in
`apps/bot/src/handlers/admin-finance/financial-reports.handler.ts` (own
composer, mounted in the admin area), entry button in the finance landing
(`admin-finance-views.ts`). Status/type labels are reused from
`user-history.service.ts` — one source of truth for wording.

## Admin path

پنل مدیریت 🛠 → مالی 💎 → **«گزارش مالی 📊»** (`admin:fin:reports`, opens
the dashboard on «امروز»). Dashboard buttons: امروز / ۷ روز اخیر / ۳۰ روز
اخیر / همه زمان‌ها (`admin:fin:rep:<today|7d|30d|all>`), «آخرین پرداخت‌ها
💳» (`admin:fin:payments:<page>`), «آخرین سفارش‌ها 🧾»
(`admin:fin:orders:<page>`), «بازگشت به مالی». Details:
`admin:fin:pay:<paymentSid>` / `admin:fin:ord:<orderSid>` — all well under
64 bytes. Every route is behind the existing admin middleware plus a
per-route `ctx.admin` check.

## Range behavior

Server time throughout (no timezone helper exists in the repo — documented
choice): «امروز» starts at the server's last local midnight
(`new Date(y, m, d)`); 7d/30d are rolling windows (now − 7/30 days); «همه
زمان‌ها» is unfiltered. All stats bucket rows by **createdAt**; in this
codebase orders are created at approval time, so createdAt ≈ paidAt and one
consistent column avoids mixed-bucket confusion.

## Dashboard metrics (three separate sections — never summed together)

1. **فروش سفارش‌ها** — count and `finalPriceToman` sum of orders with
   status **PAID or COMPLETED** (revenue = paid and not reversed), a
   per-type breakdown (🔐 خرید سرویس / ♻️ تمدید / ➕ حجم اضافه / ⏳ زمان
   اضافه / 🛍 محصول دیگر / 📍 تغییر لوکیشن — zero rows hidden), and a
   failed/cancelled/refunded count when non-zero.
2. **شارژ کیف پول** — WALLET_CHARGE payments: approved count/amount and
   pending-review count/amount. Kept out of order revenue (a top-up is not
   a sale; the later wallet purchase creates its own order).
3. **پرداخت‌ها** — payment review states: pending-review / approved /
   rejected counts (amount sums are computed and available in the service
   result). PENDING/EXPIRED/FAILED/DELETED payments count toward the total
   but no headline state.

Implementation: exactly one `groupBy` query per model
(`Order` by type+status, `Payment` by purpose+status); everything else is
in-memory. No net-profit inference.

## Latest payments (`admin:fin:payments:<page>`)

Newest first, 10/page, rows `⏳|✅|❌ amount | @user|telegramId | MM-DD`.
Detail: payment short id, purpose, status, amount, method (کارت‌به‌کارت /
کیف پول), user telegram id + username, created/reviewed dates, reviewer
admin short id, receipt-uploaded flag («ارسال شده ✅» / «—» — the media is
NEVER re-sent here), related order (type + short id + status), rejection
reason. Buttons: «بررسی رسید 💵» → the existing `admin:rec:view:<sid>`
receipt-review screen (only while PENDING_REVIEW — media handling stays
there), «مشاهده سفارش 🧾» when linked, back to list/dashboard.

## Latest orders (`admin:fin:orders:<page>`)

Newest first, 10/page, rows `⏳|✅|❌ type | amount | @user|telegramId`.
Detail: order short id, type/status labels, amount, user, snapshot-first
product name, created/paid/completed dates, linked payment (short id +
status + method), linked service (username + status), linked manual record
(short id + status), and a **flag only** «تحویل استاک: انجام شده ✅» when a
DELIVERED stock item points at the order — stock content (even encrypted)
is never selected. Buttons: «مشاهده سفارش دستی 📦» →
`admin:mo:view:<manualSid>` when a manual record exists, «مشاهده پرداخت
💳», back to list/dashboard. No raw adapter errors anywhere.

## Amount / double-counting rules

- Order revenue = `Order.finalPriceToman` over PAID/COMPLETED orders only.
- Wallet top-ups = `Payment.amountToman` over approved WALLET_CHARGE
  payments, reported separately and never added to order revenue.
- The payments section counts attempts by review state; its approved sum
  overlaps order revenue by design (it is a payment-side view, shown in its
  own section, never totaled with the others).

## Security / read-only

Admin-only; the service performs only `count`/`groupBy`/`findMany` — zero
mutations to Payment/Order/Wallet/Service/Stock/CheckoutSession. Shown ids
are 8-char prefixes only; short-id resolution uses the take-2
single-exact-match rule. Never shown: stock content (raw or encrypted),
receipt media (link to the existing review screen instead), full card
numbers, raw adapter errors, full UUIDs.

## Testing

`apps/bot/tests/admin-financial-report.test.ts` (delta-based — the shared
test DB contains other suites' rows, so assertions compare before/after
snapshots): range windows (today / 7d / 30d / all) bucket a today-row, a
10-day-old row and a 100-day-old row correctly; revenue counts
PAID+COMPLETED and excludes FAILED/CANCELLED/REFUNDED (closed counter
moves instead); per-type breakdown sums; wallet top-up approved/pending
splits; payment review-state counts; newest-first pagination of both admin
lists; short-id detail resolution with garbage rejection; the order detail
carrying manual/service/payment links and the stockDelivered flag with no
stock content (plaintext AND ciphertext absent from the JSON dump); and
admin visibility across different users' rows.

## Intentionally NOT implemented

CSV/Excel export, charts/images, accounting/tax reports, net-profit
inference, refunds/cancellation flows, receipt-media re-send, online
gateways, Telegram Stars, web panel, mini app, Phase 32+.
