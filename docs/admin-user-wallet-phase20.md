# ZED_BOT admin manual wallet management (Phase 20)

Phase 20 wires «مدیریت کاربران 👥» in the admin panel to a real (minimal)
user-management flow whose single action is **manual wallet adjustment**: an
admin searches/selects a user, opens the profile, opens «کیف پول کاربر 🏦»
and increases/decreases the balance with a **mandatory reason** and an
explicit confirmation. Every applied change is atomic, writes an accurate
`WalletTransaction` and notifies the user. The balance can **never** go
negative.

Source: `apps/bot/src/services/admin-user-wallet.service.ts`, flow in
`apps/bot/src/handlers/admin-users/{admin-users.handler,admin-users-views}.ts`.
No panel adapters, no provisioning, no CheckoutSession/Payment/Order —
only User counters + one WalletTransaction per applied change.

## Admin path

پنل مدیریت 🛠 → «مدیریت کاربران 👥» (`admin:users`, previously a
placeholder) → search/recent → «پروفایل کاربر 👤» → «کیف پول کاربر 🏦» →
افزایش/کسر. Everything is behind `adminAuthMiddleware` (the whole
`admin:*` area) plus a `ctx.admin !== null` re-check in every handler and
the text router.

| Callback | Action |
| --- | --- |
| `admin:users` | Landing («جستجوی کاربر 🔎» / «کاربران اخیر 👤» / بازگشت); clears flow state |
| `admin:users:search` | Prompts «آیدی عددی تلگرام، یوزرنیم یا شماره موبایل کاربر را وارد کنید.» (flow `admin_users:search`) |
| `admin:users:recent` | Newest 5 users by `createdAt` desc |
| `admin:users:results` | Re-runs the stored last search («بازگشت به نتایج») |
| `admin:users:view:<userSid>` | «پروفایل کاربر 👤» |
| `admin:user_wallet:open:<userSid>` | «کیف پول کاربر 🏦» |
| `admin:user_wallet:add:<userSid>` | Start INCREASE (flow `admin_wallet:amount` → `admin_wallet:reason`) |
| `admin:user_wallet:subtract:<userSid>` | Start DECREASE (same steps) |
| `admin:user_wallet:confirm` | Applies the drafted adjustment |
| `admin:user_wallet:cancel` | Clears the draft, back to the wallet page |

`<userSid>` is an 8-char uuid prefix resolved with `startsWith`; unknown or
**ambiguous** prefixes fail with «مورد یافت نشد.» — ambiguity never picks a
user.

## Search behavior

Up to 10 results, newest first. Numeric input → exact `telegramId` match
plus `phoneNumber contains` (so both ids and phone fragments work);
`@name` → exact case-insensitive username; anything else → contains over
username/firstName/lastName (case-insensitive) + phoneNumber. One match →
profile directly; several → selection list; none → «کاربری پیدا نشد.» (the
flow stays open for another try). The query is kept in session for
«بازگشت به نتایج».

## Profile / wallet pages

Profile: DB short id, telegramId, username, name, group, status, joined
date, balance, total charged, total spent, orders/paid orders. Buttons:
«کیف پول کاربر 🏦», «بازگشت به نتایج» (when a search is stored), «بازگشت به
مدیریت کاربران», «بازگشت به منوی ادمین». Wallet page: telegramId/username,
current balance, total charged/spent/discount, manual add/deduct totals and
the latest 5 wallet transactions (rendered with the Phase 13
`transactionLine`). Buttons: «افزایش موجودی ➕» / «کسر موجودی ➖» / back.

## Increase / decrease flow

1. Amount prompt («مبلغ افزایش/کسر موجودی را به تومان وارد کنید.») —
   parsed with the Phase 14 `parseTopupAmount` (Persian digits ok), must be
   an integer > 0 and ≤ 100,000,000 («مبلغ نامعتبر است.» otherwise).
2. Reason prompt («دلیل افزایش/کسر موجودی را وارد کنید.») — trimmed,
   3..500 characters, mandatory.
3. Confirmation («افزایش/کسر موجودی کیف پول») showing the target user, the
   CURRENT balance (re-read), amount, balance-after (or a warning when the
   decrease exceeds the balance) and the reason. «تایید افزایش ✅»/«تایید
   کسر ✅» applies; «انصراف» discards. **Nothing is written before confirm.**
   The draft (`adminUserWalletDraft` with a `draftNonce`) is consumed
   before executing, so a double-clicked confirmation finds no draft and
   answers «درخواست منقضی شده است.» instead of applying twice.

## Atomicity — the balance can never go negative

`adjustUserWallet` runs ONE transaction:

- **INCREASE**: `updateMany({where: {id}})` incrementing `balanceToman` +
  `totalManualAddedToman` (0 rows = user vanished → abort).
- **DECREASE**: **conditional** `updateMany({where: {id, balanceToman:
  {gte: amount}}})` decrementing `balanceToman` + incrementing
  `totalManualDeductedToman` — the exact pattern of the Phase 15 wallet
  race fix. PostgreSQL re-evaluates the condition on the committed row
  under the row lock, so concurrent decreases can never overdraw: the loser
  matches 0 rows, writes **no** WalletTransaction and the transaction rolls
  back with «موجودی کاربر کافی نیست.» (verified by a concurrent-decrease
  integration test).
- Ledger values come from re-reading the still-locked row:
  `balanceAfter = updated.balanceToman`, `balanceBefore = after ∓ amount`.
  The WalletTransaction is created in the same transaction.

## Enum mapping (no migration)

The schema already had dedicated values, so the suggested `ADMIN_MANUAL_*`
reason constants were unnecessary:

| | value |
| --- | --- |
| Increase type | `WalletTransactionType.MANUAL_ADD` |
| Decrease type | `WalletTransactionType.MANUAL_DEDUCT` |
| Source (both) | `WalletTransactionSource.ADMIN` |
| `adminId` | acting `Admin.id` |
| `reason` | the admin-entered free text (WalletTransaction has no metadata Json column; type/source/adminId are the machine identifiers, and the Phase 13 wallet history renders this reason to the user) |
| User counters | `totalManualAddedToman` / `totalManualDeductedToman` (`totalChargedToman` stays user-payment-only) |

No `AdminLog` model exists in the schema, so no separate audit row is
written — the WalletTransaction (with `adminId`) IS the audit record.

## Notifications

After a successful adjustment the target user gets a direct message
(`ctx.api.sendMessage`, same pattern as receipt review): «موجودی کیف پول
شما توسط مدیریت افزایش یافت ✅» / «موجودی کیف پول شما توسط مدیریت کسر شد.»
with amount, reason and the new balance — never the admin's identity. A
failed notification is logged as a safe warning and **never rolls back**
the mutation; the admin summary shows whether the user was reached.

## Testing

`apps/bot/tests/admin-user-wallet.test.ts` (Vitest + disposable PostgreSQL,
see `docs/testing.md`; runs in CI): concurrent decreases cannot overdraw
(one ok, one «موجودی کاربر کافی نیست.», final balance exact, single
MANUAL_DEDUCT row); increase/decrease write accurate before/after ledger
rows with type/source/adminId/trimmed reason; invalid amounts/reasons are
rejected without writes; exact-balance decrease reaches zero but never
below; manual adjustments create zero Payment/Order/CheckoutSession rows.

## Intentionally NOT implemented

Full admin user management, ban/unban, role/group changes, order/refund
management, service management from the profile, wallet transaction
pagination/reporting (Phase 21), online gateways, Telegram Stars, an
AdminLog model/migration, per-admin permission granularity beyond the
existing admin auth.
