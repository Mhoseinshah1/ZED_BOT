# ZED_BOT wallet / profile page (Phase 13)

Phase 13 wires «کیف پول + شارژ 🏦» to a real, strictly **read-only**
wallet/profile page. **Nothing in this phase mutates anything**: no
Payment, no CheckoutSession, no Order, no WalletTransaction, no balance
change, no counter updates — the page only reads and renders.

Source: `apps/bot/src/handlers/user-wallet/{wallet.handler,wallet-views}.ts`,
`apps/bot/src/services/wallet.service.ts`.

## Callbacks

| Callback | Action |
| --- | --- |
| `user:wallet` | Wallet/profile page (the existing menu button; only this placeholder route was replaced) |
| `user:wallet:refresh` | Re-reads the summary from the DB, re-renders, answers «بروزرسانی شد.» |
| `user:wallet:tx:<page>` | Transaction history (10 per page, newest first) |
| `user:wallet:topup` | Top-up **placeholder** (see below) |

## Wallet page fields

Title «کیف پول و حساب کاربری 🏦», then (actual schema fields, all
user-controlled text HTML-escaped): telegramId (`<code>`), نام
(firstName+lastName or `-`), @username or `-`, شماره تماس («ثبت نشده» when
missing), joinedAt, lastSeenAt, گروه کاربری (F کاربر عادی / N نماینده / N2
نماینده ویژه), وضعیت کاربر (ACTIVE فعال ✅ / BLOCKED مسدود 🚫 / DISABLED
غیرفعال ⏸ / DELETED حذف‌شده 🗑), موجودی (`balanceToman`, bold), مجموع
شارژ/خرید/تخفیف/برگشتی (`totalChargedToman`/`totalSpentToman`/
`totalDiscountToman`/`totalRefundedToman`), service counts (total =
non-deleted, active = status ACTIVE — computed live, counters untouched),
order counts (computed live: total by userId; paid = status in
PAID/PROVISIONING/COMPLETED), تعداد زیرمجموعه‌ها (live count of users with
`referrerId = user.id`), and the current date/time. Toman values use
thousands separators; dates render `YYYY-MM-DD HH:mm (UTC)`.

## Transactions

The wallet page shows the **latest 5** transactions; the history page
paginates 10 per page, newest first, with قبلی/بعدی + back buttons. Each
line: signed amount (sign derived from the actual
`balanceBeforeToman`→`balanceAfterToman` movement, never guessed from the
type), Persian type label (all 11 `WalletTransactionType` values mapped),
reason (known machine reasons like `REFUND_PROVISIONING_FAILED` get a
friendly label — «برگشت بابت خطای ساخت/تمدید سرویس» — unknown reasons are
escaped raw), date, and «موجودی: …» from `balanceAfterToman`. Empty state:
«تراکنشی ثبت نشده است.» Phase 9/12 refunds are therefore fully visible to
the user here.

## Top-up (placeholder replaced in Phase 14)

«افزایش موجودی 💰» was a placeholder in Phase 13. **Phase 14** replaced it
with the real card-to-card wallet charge — see
`docs/wallet-topup-phase14.md`. The wallet page itself remains read-only;
only the top-up flow creates a payment session, and the balance mutates
exclusively when an admin approves the receipt.

## Security

Every route requires `ctx.dbUser` (behind the user access gates) and every
query is scoped to `ctx.dbUser.id` — other users' transactions are
unreachable. No internal ids beyond the user's own telegramId, no card or
payment data, no admin notes, no raw JSON.

## Intentionally NOT implemented

Wallet top-up payment (card-to-card or otherwise), paying orders from the
wallet balance, online gateways, Telegram Stars, manual admin balance
adjustment, representative debt flows, negative-balance purchases,
broadcast, admin user management.
