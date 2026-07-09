# ZED_BOT wallet top-up (Phase 14)

Phase 14 replaces the Phase 13 top-up placeholder with a real card-to-card
wallet charge built on the existing payment foundation. **A wallet top-up
is not an Order**: approval increases the balance and creates a CHARGE
`WalletTransaction` — it never creates an Order/Service, never calls a
panel and never finalizes discounts.

Source: `apps/bot/src/services/wallet-topup.service.ts`, top-up flow in
`apps/bot/src/handlers/user-wallet/`, approval branch in
`apps/bot/src/services/receipt-review.service.ts`.

## Amount input

«افزایش موجودی 💰» → «مبلغ شارژ کیف پول را به تومان وارد کنید.»
(`currentFlow = "wallet:topup:amount"`). Persian/Arabic digits are
normalized, commas/spaces stripped, integers only. Limits come from the
settings `wallet_topup_min_toman` / `wallet_topup_max_toman` (defaults
10,000 / 50,000,000 تومان). Errors: «مبلغ وارد شده معتبر نیست.» / «حداقل
مبلغ شارژ کیف پول X تومان است.» / «حداکثر مبلغ شارژ کیف پول X تومان است.»
Slash commands cancel the flow; `/start`, `/menu`, the wallet page and the
admin menu clear it (shared `clearCheckoutState`).

## Pre-invoice

«پیش‌فاکتور شارژ کیف پول 🏦» with مبلغ شارژ, موجودی فعلی, موجودی بعد از
شارژ and the admin-approval note; buttons: «ادامه و انتخاب روش پرداخت ✅» /
«تغییر مبلغ» / «لغو» / «بازگشت به کیف پول». Nothing is written until
continue.

## Payment session design

The schema already has `CheckoutPurpose.WALLET_CHARGE` and
`PaymentPurpose.WALLET_CHARGE`, so **no migration was needed** — that is
the documented choice. On continue a `CheckoutSession` is created with
`purpose WALLET_CHARGE`, `orderType/productId/serviceId` null,
`originalPriceToman = finalPriceToman = amount`, `discountAmountToman = 0`,
snapshot `{ flowType: "WALLET_TOPUP", walletTopupAmountToman, title: "شارژ
کیف پول" }`, `PENDING` + the standard expiry (older PENDING top-up sessions
of the user are cancelled). It then reuses the unchanged Phase 7 surface:
gateway filtering by amount/groups/visibility, card screen, copy buttons
and receipt upload. `submitReceipt` mirrors the checkout purpose onto the
Payment (`WALLET_CHARGE`; `orderId` stays null forever) and the user sees
«رسید شارژ کیف پول شما ثبت شد و در انتظار بررسی است.» The «مشاهده
پیش‌فاکتور» view shows «نوع: شارژ کیف پول 🏦» instead of product lines.

## Admin review

Top-up receipts appear in the same PENDING_REVIEW list; the detail view now
shows «نوع پرداخت: شارژ کیف پول 🏦» (and omits the product line). The Phase
8.1 confirmation step and all validations (checkout PENDING, exact amount
match, pending receipt exists, submitted before expiry) apply unchanged.

**Approval (one transaction, no partial state possible):** compare-and-set
Payment `PENDING_REVIEW → APPROVED` (filtered on purpose), receipts →
APPROVED, checkout → PAID, then — guarded by «no existing WalletTransaction
with `relatedPaymentId` + reason `WALLET_TOPUP_CARD_TO_CARD`» — a fresh
balance read, `balanceToman += amount`, `totalChargedToman += amount`, and
one `WalletTransaction` (`type CHARGE`, `source USER_PAYMENT`, reason
`WALLET_TOPUP_CARD_TO_CARD`, `relatedPaymentId`, `relatedOrderId` null,
balance before/after). Because the flip and the wallet mutation commit
together, an APPROVED wallet payment always has its transaction; double
clicks lose the CAS and re-runs hit the transaction guard — the balance can
never increment twice. **No Order, no provisioning, no discount
finalization.**

User success: «شارژ کیف پول شما تایید شد ✅ / مبلغ شارژ: X تومان / موجودی
جدید: Y تومان». Admin: «رسید شارژ کیف پول تایید شد ✅ / موجودی کاربر افزایش
یافت.» The new balance is immediately visible on the Phase 13 wallet page.

**Rejection** reuses the Phase 8 reason flow unchanged (reason required,
stored, checkout stays PENDING while unexpired / EXPIRED otherwise); no
wallet mutation. The user notice is wallet-aware: «رسید شارژ کیف پول شما رد
شد ❌ …».

## Order payments unchanged

`approveReceiptPayment` dispatches on `payment.purpose`: `ORDER_PAYMENT`
keeps the exact Phase 8/9/12 behavior (Order creation, discount
finalization, provisioning/renewal dispatch); `WALLET_CHARGE` takes the
wallet path above. The result union carries `kind: "ORDER_PAYMENT" |
"WALLET_TOPUP"` for the receipts handler.

## Intentionally NOT implemented

Paying orders from the wallet balance (no deduction anywhere), online
gateways, Telegram Stars, admin manual balance adjustment, representative
debt, negative-balance purchase, cashback, automatic receipt verification,
gateway management UI.
