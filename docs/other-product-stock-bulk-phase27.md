# ZED_BOT bulk stock-item creation (Phase 27)

Phase 27 adds a **multiline bulk-add flow** to the Phase 25 stock inventory
(`docs/other-product-stock-phase25.md`): one message, one item per line, all
stored encrypted. Pure admin configuration — auto-delivery, payments,
receipts and orders are untouched, no Service rows, no user notification.

Source: `parseBulkStockInput` / `addStockItemsBulk` in
`apps/bot/src/services/other-product-stock.service.ts`, wizard in
`apps/bot/src/handlers/admin-stock/stock.handler.ts`. No migration.

## Admin path

پنل مدیریت 🛠 → «محصولات دیگر / سفارش‌های محصولات دیگر» → «مدیریت موجودی
محصولات 🎟» → انتخاب محصول → **«افزودن گروهی آیتم‌ها ➕➕»**
(`admin:stock:bulk_add:<productSid>`, flow `admin_stock:bulk_content`,
confirm/cancel `admin:stock:bulk_confirm` / `admin:stock:bulk_cancel`).
Admin-only through the existing middleware; `clearAdminStockState` (admin
main menu etc.) clears the bulk flow and draft like the single-add wizard.

## Input rules

Prompt: «هر آیتم را در یک خط جدا وارد کنید. / خط‌های خالی نادیده گرفته
می‌شوند.» Each line is trimmed; empty lines are skipped; a line longer than
4000 chars counts as **invalid** (skipped); an exact duplicate of an earlier
line in the same message counts as **duplicate** (first occurrence kept).
Zero valid unique items → «هیچ آیتم معتبری در متن پیدا نشد.» and the flow
stays open for a corrected resend. More than **100** valid unique items →
the batch is **rejected** («حداکثر ۱۰۰ آیتم در هر بار قابل ثبت است.») so the
admin splits it — nothing is silently dropped. (Inbound Telegram messages
are capped at 4096 chars anyway, which bounds the practical batch size
further.)

**No DB duplicate check** — deliberately. Content is stored with randomized
AES-256-GCM encryption, so detecting an already-stored duplicate would
require decrypting the entire inventory; duplicates are only detected within
the submitted batch.

## Confirmation

«افزودن گروهی موجودی 🎟» shows the product name, the valid-unique count, the
duplicate-skipped count, the invalid-skipped count and **masked previews of
the first 5 items only** (`stockContentPreview`, 8 chars + ellipsis), plus
the note «محتوای کامل بعد از ثبت نمایش داده نمی‌شود.» Buttons: «تایید افزودن
گروهی ✅» / «انصراف». The full raw content is never echoed back — not in the
confirmation, not in the result, not in logs.

## Create behavior

The draft is consumed **before** any DB write (a double-clicked confirm gets
«درخواست منقضی شده است…», never a second batch). `addStockItemsBulk`
re-validates and re-dedupes defensively, encrypts each line with
`encryptSecret`, and inserts everything with one `createMany` — a single
atomic INSERT, so a mid-batch DB failure creates **nothing** and the admin
sees a safe error («ثبت گروهی آیتم‌ها ناموفق بود…»). Every item is created
`AVAILABLE`, `label null`, `createdByAdminId` set. The result toast reports
the created count only. No Payment/Order/CheckoutSession row is touched and
no user is notified.

## Testing

`apps/bot/tests/other-product-stock-bulk.test.ts`: pure parser tests (trim,
empty-line skip, in-batch dedupe keeping the first occurrence, over-length
lines counted invalid, zero-valid and over-100 rejection with exact safe
messages, CRLF input) run without a DB; DB tests cover bulk creation
(N AVAILABLE items, ciphertext ≠ plaintext, decrypt round-trip, `label null`,
`createdByAdminId` set), a missing/non-OTHER_PRODUCT product failing safely,
service-level over-100/empty rejection, and that no safe message ever
contains raw content.

## Intentionally NOT implemented

CSV upload, file upload, Excel import, stock export, per-line labels in
bulk (single add keeps labels), DB-wide duplicate detection (above),
refunds/cancellation, wallet payment for OTHER_PRODUCT, online gateways,
Telegram Stars, reports, web panel, mini app, Phase 28+.
