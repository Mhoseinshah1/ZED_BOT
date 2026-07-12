# Corrective UI/UX Fix A — gap report (before / after)

Real source-code changes only; audit docs alone were explicitly not
acceptable. Scope: admin finance nesting, user wallet landing cleanup,
direct renewal from service detail. Locked behavior untouched:
**subscription purchase unchanged** (`CB.USER_BUY` = `user:buy`,
panel-first) and **«محصولات دیگر» stays a separate section**
(`CB.USER_OTHER_PRODUCTS`).

## 1. Duplicated admin receipts root button

| | before | after |
| --- | --- | --- |
| admin root | «رسیدهای تایید نشده 💵» visible at the root AND inside مالی | receipts button removed from the root |
| finance landing | also had a receipts button (duplicate) | the single receipts entry: «رسیدهای تاییدنشده 💵» (row 1) |
| `CB.ADMIN_RECEIPTS` | registered | unchanged — `receipts.handler.ts` still answers it (old keyboards keep working) |

Known cosmetic variance: the finance-landing button uses the specified
spelling «رسیدهای تاییدنشده 💵» while the (locked) receipts page title and
the receipt-notification button keep the pre-existing «رسیدهای تایید
نشده 💵» — same callback, same destination; not aligned to keep the locked
receipt surface untouched.

Admin root after (5 rows): مالی 💎 · مدیریت کاربران 👤 /
مدیریت محصولات/پلن‌ها · مدیریت پنل‌ها / محصولات دیگر … /
تیکت‌های پشتیبانی 🎫 · پیام همگانی 📣 / تنظیمات عمومی ⚙️ · گزارشات / بکاپ.
The unfinished placeholder buttons (قابلیت‌های پنل، آپدیت ربات، بخش آموزش،
تنظیمات مینی اپ، قیمت سرویس دلخواه) are no longer rendered on the root;
their callbacks stay answered by `admin-placeholders.handler.ts`.

## 2. Finance tree

| | before | after |
| --- | --- | --- |
| rows | روش‌ها / تنظیمات / رسیدها / گزارش / بازگشت (5 single-button rows) | رسیدهای تاییدنشده 💵 / روش‌های پرداخت 💳 · تنظیمات کیف پول و پرداخت 🏦 / مدیریت کیف پول کاربران 👤 · گزارش مالی 📊 / بازگشت به پنل ادمین |
| user wallet management | only reachable via مدیریت کاربران on the root | also linked from finance via the EXISTING `CB.ADMIN_USERS` entry — no duplicate wallet-management service was built |
| callbacks | — | none renamed; `FIN_CB.methods`, `FIN_CB.settings`, `admin:fin:reports`, `CB.ADMIN_RECEIPTS`, `CB.ADMIN_USERS`, `CB.ADMIN_MENU` |

## 3. Wallet landing fields

| | before | after |
| --- | --- | --- |
| identity | id/name/username/phone/joined **+ lastSeenAt + internal status** | id, name, username, phone, registration date only |
| money | balance **+ totalCharged/totalSpent/totalDiscount/totalRefunded** | balance only |
| counters | services, activeServices, totalOrders, paidOrders, referrals | services, **pendingOrders (new)**, referrals |
| extras | latest-5 transaction preview + current server timestamp | removed — transactions live in «تاریخچه تراکنش‌ها 📋» |
| keyboard | back label «بازگشت به منو» | exact rows: افزایش موجودی 💰 / تاریخچه تراکنش‌ها 📋 · بروزرسانی ♻️ / **«بازگشت به منوی اصلی»** |

`WalletSummary` now carries `pendingOrders` — orders in
`PENDING_PAYMENT` / `WAITING_RECEIPT` / `PENDING_REVIEW` only (paid /
completed / cancelled / failed / refunded are never counted). Queries stay
owner-scoped and read-only. Top-up and payment logic unchanged.

## 4. Wallet template keys

| key | default | used by |
| --- | --- | --- |
| `wallet_header_text` | کیف پول و حساب کاربری 🏦 | landing heading |
| `wallet_topup_amount_prompt` | مبلغ شارژ کیف پول را به تومان وارد کنید. | top-up amount prompt |
| `wallet_topup_preview_note` | پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد. | top-up pre-invoice note |
| `wallet_empty_transactions_text` | تراکنشی ثبت نشده است. | empty transaction history |

Before: all four were hardcoded literals. After: seeded create-if-missing
(operator edits never clobbered) + code fallbacks in `text.service.ts`,
editable via the Phase 34 «مدیریت متن‌ها ✍️». Only headings/prompts/notes/
empty messages are templated — amounts stay formatted/escaped in code, the
wallet page is NOT one big HTML template, and the Phase 22 Setting-backed
top-up instruction / payment-page notice are NOT duplicated. Because these
pages are sent with parseMode HTML, the three template values rendered
into them are HTML-escaped at the interpolation points — an operator edit
containing `<` or a broken tag renders literally instead of silently
failing the Telegram send.

## 5. Direct service renewal button

| | before | after |
| --- | --- | --- |
| renewing a specific service | main menu → تمدید سرویس ♻️ → find it in the renewal list | service detail shows «تمدید سرویس ♻️» directly (position 4 of the action order) |
| callback | — | the EXISTING `rncb.service(sid)` route `user:renew:svc:<sid>` — no new renewal path |
| eligibility | — | `canRenew` on `ServiceDetailActions`, computed from the exported `RENEWABLE_STATUSES` + panel ACTIVE (no duplicated status rules); the renewal handler re-checks via `getRenewableServiceByShortId` on click |
| back behavior | plans page returns to the renewal list | kept as-is (documented) — a detail-aware back would need fragile session state |

## Deferred

- **Receipt-detail extra actions → Corrective Fix B** (not started).
- **Service transfer / user note / QR code** — not added, deferred.
- Detail-aware back from the renewal plan page.

## Verification

Locked/structural assertions live in
`apps/bot/tests/corrective-fix-a.test.ts`; the full suite (payment,
renewal, wallet race, receipts, delivery, history) passes unchanged.
