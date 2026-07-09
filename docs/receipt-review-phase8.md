# ZED_BOT receipt review (Phase 8)

Phase 8 turns the read-only Phase 7 receipts list into a real review queue:
admins approve or reject `PENDING_REVIEW` card-to-card payments. Approval
creates the `PAID` Order and finalizes discount usage; rejection asks the
admin for a reason and sends it verbatim to the user.

**Core rule — still no Service, no panel call, no wallet deduction, no
config/link, no OtherProductOrder.** Approval leaves a `PAID` Order behind;
provisioning/delivery picks those up in Phase 9.

Source: `apps/bot/src/services/receipt-review.service.ts`,
`apps/bot/src/handlers/admin-receipts/receipts.handler.ts`.

## Admin callbacks

| Callback | Action |
| --- | --- |
| `admin:receipts` / `admin:rec:list:<page>` | Pending-review list (unchanged shape) |
| `admin:rec:view:<paymentSid>` | Receipt detail — now shows status and, for `PENDING_REVIEW`, the two review buttons |
| `admin:rec:ap:<paymentSid>` | «تایید رسید ✅» — approve immediately (double-click safe) |
| `admin:rec:rj:<paymentSid>` | «رد رسید ❌» — asks for the rejection reason first |

The detail view of an already-reviewed payment shows its status (تایید شده ✅
/ رد شده ❌ + stored reason) and offers no review buttons.

## Approval behavior

`approveReceiptPayment(paymentId, admin)` validates (payment exists, purpose
`ORDER_PAYMENT`, status `PENDING_REVIEW`, checkout present) and then runs ONE
transaction:

1. **Compare-and-set** `Payment`: `PENDING_REVIEW → APPROVED` with
   `paidAt`/`reviewedAt` = now and `reviewedByAdminId`. The `updateMany` is
   filtered on `PENDING_REVIEW`, so a second click / concurrent approval
   flips nothing and gets «این رسید قبلاً بررسی شده است.»
2. `ManualReceipt`(s) of the payment → `APPROVED` + review metadata.
3. `CheckoutSession` → `PAID`, `paidAt` = now.
4. **Order** — reused if one already exists for the `checkoutSessionId`
   (never duplicated), otherwise created with: `userId`,
   `checkoutSessionId`, `type` from `checkout.orderType` (fallback derived
   from the snapshot's `productType`), `status = PAID`, `productId`,
   `serviceId`, `paymentId` (primary payment), the three price fields,
   `discountCodeId`, `paidAt`, and the snapshot columns
   (`productNameSnapshot`, `productDescriptionSnapshot`,
   `productPriceSnapshot`, `durationDaysSnapshot`, `volumeGbSnapshot`,
   `panelNameSnapshot`, `locationSnapshot`, `categorySnapshot`) copied from
   `checkout.productSnapshot`. `Payment.orderId` is linked back.
5. Only when the Order was actually created, user stats move once:
   `ordersCount +1`, `paidOrdersCount +1` (this is what unlocks gateways
   gated by `activateAfterSuccessfulPaymentsCount`),
   `totalPurchaseAmountToman += finalPriceToman`.
6. **Discount finalization (idempotent)**: when `checkout.discountCodeId`
   is set and `discountAmountToman > 0`, a `DiscountCodeUsage` row is
   created and `DiscountCode.totalUsedCount` incremented — but only if no
   usage row exists yet for this `checkoutSessionId`. Re-approval attempts
   can never double-count.

## Order / checkout status choice

- `Order.status = PAID` — payment approved, provisioning not started.
  Phase 9 picks PAID orders up. Never `COMPLETED`, never `PROVISIONING`
  in this phase.
- `CheckoutSession.status = PAID` on approval (not `COMPLETED` — that waits
  for delivery). On rejection the checkout stays `PENDING` while unexpired
  so the user can pay again; an already-expired one is flipped to `EXPIRED`.
  Never `PAID` on rejection.

## Rejection reason flow

«رد رسید ❌» sets `session.currentFlow = "receipt:reject"` +
`session.temp.rejectingPaymentId` and prompts for the reason (1..1000
chars — invalid lengths re-prompt without leaving the flow). The status does
NOT change until the reason text arrives. «انصراف» returns to the detail
view and clears the flow; slash commands cancel the flow and run normally
(`/admin` already clears every flow when it renders the admin menu). The
flow is routed in `app.ts` before user text flows and only consumes text
from active admins.

`rejectReceiptPayment` then (same compare-and-set pattern, one transaction)
sets `Payment → REJECTED` with `rejectReason`/`reviewedAt`/
`reviewedByAdminId`, the `ManualReceipt`(s) → `REJECTED` with the same
metadata, and applies the checkout rule above. No Order, no discount usage,
no counter changes.

## User notifications

Sent from the handler AFTER the transaction (never inside it), via
`ctx.api.sendMessage(user.telegramId, …)`. A send failure never rolls back
the review — it is logged (no card numbers, no file ids) and the admin sees
«اما ارسال پیام به کاربر ناموفق بود.»

- Approval (service products): «رسید پرداخت شما تایید شد ✅ / سفارش شما ثبت
  شد و در مرحله آماده‌سازی قرار گرفت. / ساخت سرویس در مرحله بعدی فعال
  می‌شود.»
- Approval (`OTHER_PRODUCT`, determined from checkout/orderType snapshot):
  «رسید پرداخت شما تایید شد ✅ / سفارش محصول شما ثبت شد و در انتظار مرحله
  تحویل است.» (No `OtherProductOrder` is created in this phase.)
- Rejection — exact format:

  ```
  رسید پرداخت شما رد شد ❌

  دلیل رد:
  <reason>

  لطفاً در صورت نیاز دوباره پرداخت را انجام دهید یا با پشتیبانی تماس بگیرید.
  ```

Admin result messages: «رسید تایید شد ✅ / Order ساخته شد. / ساخت
سرویس/تحویل در فاز بعدی انجام می‌شود.» and «رسید رد شد ❌ / دلیل برای کاربر
ارسال شد.» (or the notification-failed variant).

## Intentionally NOT implemented

Service creation / panel provisioning (Phase 9), OtherProductOrder rows,
wallet deduction or cashback, refunds, media forwarding of receipt files to
admins/log groups, receipt-review role restrictions beyond the existing
admin gate, online-gateway verification, and any expiry worker. Reviews are
strictly manual and strictly card-to-card for now.
