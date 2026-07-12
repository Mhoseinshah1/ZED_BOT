# Corrective UI/UX Fix B

Real source-code changes: admin receipt detail actions/navigation, safe
navigation-only links from the receipt detail into the existing user/wallet
management, and the nesting of OTHER_PRODUCT / manual orders / stock
management under one logical landing with direct-parent backs.

**Explicitly true after Fix B:** no receipt hard-delete was added; no
wallet mutation happens from the receipt detail (buttons only NAVIGATE to
the existing Phase 20 flows with their own confirmations); no immediate
user block from the receipt detail; no stock content exposure anywhere
(lists/details keep the masked-preview-only rule); the subscription
purchase flow is untouched (`CB.USER_BUY` = `user:buy`); OTHER_PRODUCT
remains a completely separate section (`CB.USER_OTHER_PRODUCTS`).

## Receipt detail fields («جزئیات رسید 🧾»)

Receipt short id · payment purpose (شارژ کیف پول 🏦 / پرداخت سفارش) ·
payment status · user (name, username, Telegram numeric id) · amount ·
payment method/gateway (name + type) · checkout short id · order short id
(when linked) · product name (order payments) · receipt type (فایل/عکس یا
متن) · receipt text (when present) · rejection reason (when rejected) ·
created + reviewed timestamps. Everything dynamic is HTML-escaped; card
secrets, tokens, DATABASE_URL, stack traces, stock content and panel
credentials never render, and the Telegram file id is never shown or
logged.

## Receipt detail keyboard

| state | rows |
| --- | --- |
| PENDING_REVIEW | تایید رسید ✅ · رد رسید ❌ / ارسال/مشاهده رسید و مشخصات 🧾 / افزایش موجودی کاربر 💰 · مدیریت/مسدودسازی کاربر 👤 / بازگشت به لیست · بازگشت به مالی |
| reviewed (APPROVED/REJECTED) | same minus approve/reject |

- «ارسال/مشاهده رسید و مشخصات 🧾» (`admin:rec:media:<sid>`) sends the
  stored media ON DEMAND (photo first, document fallback) with a short
  caption (short id, user label, amount); text-only receipts show the text;
  no content answers «فایل یا متن رسید ثبت نشده است.»; a failed send
  answers safely. The detail page itself no longer auto-forwards media on
  every render (old Phase 21.1 behavior removed).
- «افزایش موجودی کاربر 💰» (`admin:rec:uwallet:<sid>`) opens the EXISTING
  user wallet page (Phase 20) — its own افزایش ➕ / کسر ➖ buttons and
  confirmation flow do the mutation.
- «مدیریت/مسدودسازی کاربر 👤» (`admin:rec:user:<sid>`) opens the EXISTING
  user profile page. **Deferred:** no block/unblock feature exists in the
  codebase yet, so none was invented — when it lands on the profile page,
  this navigation reaches it automatically.

## Receipt navigation

- Receipt list back → **finance landing** (`admin:finance`), not the admin
  root. The current list page is stored in the session
  (`adminReceiptListPage`).
- Detail «بازگشت به لیست» → the stored list page (fallback 1);
  «بازگشت به مالی» → `admin:finance`.
- Approve/reject completion → «بازگشت به لیست رسیدها» (stored page) +
  «بازگشت به مالی». Reject cancel → the same receipt detail.
- Pagination retains the current page.

## Return-to-receipt context

Jumping from a receipt detail into the user pages stores
`adminUserReturnContext = { kind: "receipt", receiptId, receiptPage }`;
while it exists, the user profile/wallet pages (and the wallet-adjustment
summary) show «بازگشت به رسید 🧾» back to that exact receipt. The context
is cleared on the users landing, on the admin main menu, and when arriving
back at any receipt detail. Normal user search/list/profile navigation is
completely unchanged when no context exists.

## OTHER_PRODUCT admin tree («محصولات دیگر 🛍»)

`admin:other_products` now opens the single logical landing (with the open
/ waiting-info / ready / delivered counters):

| row | button → destination |
| --- | --- |
| 1 | مدیریت محصولات دیگر 🛍 → `admin:products` (existing product management — a type-filtered list is deferred) |
| 2 | سفارش‌های دستی 📦 → `admin:mo:list:open:1` · سفارش‌های در انتظار اطلاعات 📝 → `admin:mo:list:info:1` |
| 3 | سفارش‌های آماده تحویل 🚚 → `admin:mo:list:ready:1` · تاریخچه تحویل ✅ → `admin:mo:list:delivered:1` |
| 4 | مدیریت موجودی استاک 🎟 → `admin:stock:products` |
| 5 | بازگشت به پنل ادمین → `admin:menu` |

Every destination is an existing implementation — no duplicated services.

## Manual-order navigation

- Filtered lists: «جستجوی سفارش 🔎» moved onto the lists; back →
  «بازگشت به محصولات دیگر» (the landing).
- Detail: back to the SAME filter/page via the existing session context
  (`adminManualOrderLastFilter/Page`), search-results back when the detail
  was reached from a search; final back → the landing.
- Deliver/remind/search completion re-renders the same detail/results.
- Delivery business logic unchanged.

## Stock tree and status filters

Stock stays nested under محصولات دیگر → مدیریت موجودی استاک 🎟. The
product page now exposes: افزودن آیتم تکی ➕ · افزودن گروهی آیتم‌ها ➕➕ /
آیتم‌های موجود ✅ · آیتم‌های رزروشده ⏳ / آیتم‌های غیرفعال ⏸ · تاریخچه
تحویل 📦 / تنظیم حد هشدار 🔔 / پاک کردن حد هشدار (when set) /
روشن/خاموش کردن تحویل استاک / بازگشت به لیست محصولات استاک / بازگشت به
محصولات دیگر.

Status-filtered item lists (`listStockItems` gained an optional status):
`admin:stock:items:<sid>:<a|r|x|d>:<page>` (a=AVAILABLE, r=RESERVED,
x=DISABLED, d=DELIVERED — one-byte aliases keep callbacks far under 64
bytes). Item actions carry `:<alias>:<page>` so every action returns to
the same product/status/page. Existing action rules only: AVAILABLE may be
disabled; stuck RESERVED may be released or disabled (Phase 26); DISABLED
has no re-enable (not invented); DELIVERED is immutable, read-only
history. No decrypted content anywhere — masked previews only.

## Backward-compatible callbacks retained

- `admin:receipts` + `admin:rec:list/view/ap/rj` (unchanged shapes).
- `admin:other_products` → now the new landing (logical parent redirect).
- `admin:mo:list:<page>` (legacy Phase 23), `admin:mo:list:<filter>:<page>`,
  `admin:mo:view/deliver/remind/search` — all unchanged.
- `admin:stock:items:<sid>:<page>` (all-statuses list) still handled next
  to the new filtered routes; `admin:stock:item_off/item_release/
  item_disable_reserved:<sid>` work with or without the new
  status/page suffix.
- No callback constant renamed or removed.

## Deferred

- User block/unblock (no existing implementation — not invented).
- OTHER_PRODUCT-filtered product management list («مدیریت محصولات دیگر»
  currently opens the general product management).
- Receipt filters for already-reviewed receipts (the list remains
  PENDING_REVIEW-only, as before).

## Tests

`apps/bot/tests/corrective-fix-b.test.ts` (21 tests, DB-free): pending vs
reviewed detail keyboards, detail fields + no-file-id rendering, list/
review-result backs to finance, media action outcomes (photo, document
fallback, text-only, none, failure) with a recorder API, no-file-id-logging
lock, no-mutation locks (no `adjustUserWallet`/`prisma.user.update` in the
receipts handler), return-to-receipt context buttons + cleanup, exact
OTHER_PRODUCT landing rows, manual-order same-filter/page back, stock
product page + status filters + callback size, immutable delivered/disabled
items, no-decrypt lock, and the locked CB constants + legacy routes.
