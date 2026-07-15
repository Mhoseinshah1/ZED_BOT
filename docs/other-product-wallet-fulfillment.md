# Wallet payment + unified fulfillment for other products

This phase lets `OTHER_PRODUCT` checkout sessions be paid from the internal
wallet, and unifies what happens AFTER any payment becomes definitively
successful: wallet, card-to-card receipt approval, Zarinpal, NOWPayments and
Telegram Stars all converge on one post-commit dispatcher, so fulfillment
behavior is identical regardless of payment method.

Sources:

- `apps/bot/src/services/order-fulfillment.service.ts` — the dispatcher
- `apps/bot/src/services/wallet-payment.service.ts` —
  `payPurchaseDraftWithWallet` (now both product types)
- `apps/bot/tests/other-product-wallet.test.ts` — the 12-scenario suite

## The shared dispatcher

```
dispatchPaidOrderFulfillment(api, orderId, { source, user? })
  source: "WALLET" | "RECEIPT" | "GATEWAY"
```

Callers (the only three): the wallet confirm handlers
(`user-checkout`/`user-renewal`/`user-extra-volume`/`user-extra-time`), the
receipt approval handler (`admin-receipts/receipts.handler.ts`) and the
gateway settlement (`fulfillSettledGatewayOrder`, also used by the sweep).
Every caller commits its financial transaction FIRST; the dispatcher performs
no financial writes and never runs inside a database transaction (no
Telegram sends or stock delivery inside the money transaction).

Dispatch by `Order.type`:

| Type | Executor | User message |
| --- | --- | --- |
| SERVICE_PURCHASE | `provisionPaidOrder` | service info / refund notice |
| SERVICE_RENEWAL | `executeRenewalOrder` | renewal success / refund notice |
| EXTRA_VOLUME | `executeExtraVolumeOrder` | volume success / refund notice |
| EXTRA_TIME | `executeExtraTimeOrder` | time success / refund notice |
| OTHER_PRODUCT | stock auto-delivery → manual queue | see below |

**Idempotency.** Executors are CAS-claimed; `autoDeliverStockOrder` resumes
its own reserved item and answers `ALREADY_DELIVERED` on repeats;
`initManualDelivery` is unique per order and its `created` flag gates the
prompt and the admin notification. A repeated dispatch (sweep, replay, retry,
double-click) converges on the existing state and never deducts again,
creates a second Payment/Order/OtherProductOrder, reserves another stock
item, re-prompts the user or re-alerts the admins.

## OTHER_PRODUCT flow

1. `autoDeliverStockOrder` — stock-eligible products (deliveryType
   `STOCK_ITEM` or `stockEnabled`, never with required user info) deliver one
   encrypted stock item; the order completes and admins get the low/out
   stock alert. `NOT_ELIGIBLE` / `NO_STOCK` / send-failure (user received
   nothing) fall through to the manual queue.
2. `initManualDelivery` — creates THE `OtherProductOrder`:
   `WAITING_USER_INFO` when `Product.requiredUserInfoEnabled`, else
   `WAITING_ADMIN_DELIVERY`.
3. Messages (first line varies by `source`, the rest is identical):

   - required info (`WAITING_USER_INFO`) — admins are NOT notified yet:

     ```
     پرداخت از کیف پول با موفقیت انجام شد ✅   | رسید پرداخت شما تایید شد ✅   | پرداخت شما تایید شد ✅

     برای تکمیل سفارش، اطلاعات خواسته‌شده را ارسال کنید.

     <configured requiredUserInfoPromptText prompt>
     ```

     plus the existing «تکمیل اطلاعات سفارش 📝» button. When the user
     submits the info the record flips to `WAITING_ADMIN_DELIVERY`
     (status-guarded, double submits rejected) and THEN the admins are
     notified («سفارش دستی جدید 📦»).

   - no required info (`WAITING_ADMIN_DELIVERY`) — customer is told once,
     admins are notified immediately:

     ```
     <method line>

     سفارش شما ثبت شد و در انتظار تحویل است.
     ```

## Wallet payment for OTHER_PRODUCT

`payPurchaseDraftWithWallet` accepts both product types and maps
`OTHER_PRODUCT → OrderType.OTHER_PRODUCT`. Nothing from the session is
trusted — the product is reloaded with relations and visibility, active
state, price, discount validity/amount and final amount are recomputed. The
existing atomic transaction is unchanged: PAID `CheckoutSession` (settled by
the wallet payment via `settledByPaymentId`), APPROVED Payment (purpose
`PAY_WITH_WALLET`, method `WALLET`), PAID Order, conditional balance
deduction (`updateMany` … `balanceToman: { gte: finalPriceToman }`, count
must be 1) and one SPEND `WalletTransaction` with exact before/after values —
all committing together. Idempotency key `wallet:<userId>:<draftNonce>`
makes double-clicks replay the first result; different drafts compete on the
balance itself (overspend impossible). No `Service` row is ever created for
`OTHER_PRODUCT`.

## Card-to-card behavior (preserved)

Receipt submission leaves the payment `PENDING_REVIEW`: no order, no
`OtherProductOrder`, no information request. Approval commits the money
(`approveReceiptPayment`) and then dispatches the same shared fulfillment;
rejection creates nothing and never asks for information.
