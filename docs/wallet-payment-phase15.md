# ZED_BOT wallet payment for orders (Phase 15)

Phase 15 lets users pay **service purchase** and **service renewal**
pre-invoices directly from their wallet balance. Wallet payment is an
immediate method: no card account, no receipt, no `ManualReceipt`, no
`PENDING_REVIEW`, no admin review — the order settles instantly and the
existing Phase 9/12 provisioning/renewal pipeline runs right away.

Source: `apps/bot/src/services/wallet-payment.service.ts`, buttons/confirm
screens in `apps/bot/src/handlers/user-checkout/` and
`apps/bot/src/handlers/user-renewal/`.

## Button rules

«پرداخت با کیف پول 🏦» appears on a pre-invoice ONLY when:

- purchase: draft `flowType = SERVICE_PRODUCT`, `finalPriceToman > 0`, and
  `user.balanceToman >= finalPriceToman`;
- renewal: `finalPriceToman > 0` and `user.balanceToman >=
  finalPriceToman`.

Insufficient balance shows the line «موجودی کیف پول برای پرداخت کافی
نیست.» and no button (never a negative-balance option). The button never
appears for wallet top-up (`WALLET_CHARGE`) checkouts or the card-to-card
method list. `finalPriceToman = 0` (full discount) gets no wallet button —
free checkout is a later phase («پرداخت رایگان در فاز بعدی فعال می‌شود.»).

## Confirmation

Clicking the button shows «آیا از پرداخت با کیف پول مطمئن هستید؟» with
مبلغ پرداخت / موجودی فعلی / موجودی بعد از پرداخت and «تایید پرداخت ✅» /
«انصراف» (back to the pre-invoice). Nothing is deducted before the
confirmation click.

## Transaction (purchase and renewal share it)

Pre-checks outside the transaction re-validate everything from the DB —
product visibility/type, panel/category match, renewal service ownership +
plan-on-same-panel (Phase 12 rules), and the discount for the right purpose
(`PURCHASE`/`RENEWAL`; an invalidated code aborts with a safe message
instead of charging a surprise amount). Session prices are never trusted:
the amount is recomputed from the product + discount.

Then ONE transaction:

1. fresh user read; abort («موجودی کیف پول کافی نیست.») unless
   `balanceToman >= finalPriceToman` — negative balance is impossible;
2. `CheckoutSession` created directly as **PAID** (`purpose
   ORDER_PAYMENT`, orderType `SERVICE_PURCHASE`/`SERVICE_RENEWAL`,
   product/service ids, the normal Phase 6/12 snapshot, `paidAt`) — no
   PENDING window that could be paid twice;
3. `Payment` created **APPROVED** with `purpose PAY_WITH_WALLET` (the enum
   existed — checkout purpose stays ORDER_PAYMENT because the flow is an
   order payment; the payment purpose identifies the source),
   `callbackPayload {method: "WALLET"}`, `idempotencyKey`;
4. `Order` created **PAID** with payment link, prices, `discountCodeId`
   and the standard snapshot columns (`panelId` stays null like every
   other order — the pipelines resolve the panel themselves);
5. wallet counters move together: `balanceToman −= final`,
   `totalSpentToman += final`, `totalDiscountToman += discount` (when >0),
   `ordersCount`/`paidOrdersCount` +1, `totalPurchaseAmountToman += final`;
6. `WalletTransaction`: `type SPEND`, `source ORDER`, reason
   `WALLET_ORDER_PAYMENT`, `relatedOrderId`/`relatedPaymentId`, balance
   before/after;
7. discount finalization (usage row + `totalUsedCount`), idempotent.

Everything commits together — a deducted balance always has its
checkout/payment/order, and vice versa.

## Idempotency

Every pre-invoice mints a `draftNonce` (UUID) when it opens;
`Payment.idempotencyKey = wallet:<userId>:<draftNonce>` (unique column). A
double click or a concurrent duplicate hits the unique key: the loser
returns the FIRST settled result (`alreadyPaid`) — one deduction, one
order, ever. Buying the same product again later gets a fresh nonce, so
intentional repeat purchases are unaffected.

## Dispatch + refunds

After settling, the handler immediately runs the **unchanged** pipeline —
`provisionPaidOrder` for purchases (service info message on success) or
`executeRenewalOrder` for renewals (renewal success message). On failure
the existing FAILED + wallet-refund path runs, so the history shows the
SPEND followed by the REFUND and the balance is restored; the user gets the
existing failure texts. In-progress edge cases get «پرداخت انجام شد و
سفارش/تمدید شما در حال آماده‌سازی است.»

> **Phase 16 update:** the same atomic wallet-payment transaction now also
> settles `EXTRA_VOLUME` orders (idempotency key
> `wallet:<userId>:extra-volume:<draftNonce>`) — see
> `docs/extra-volume-phase16.md`.

## Receipt review untouched

`PAY_WITH_WALLET` payments are born APPROVED with no `ManualReceipt`, so
they never appear in the PENDING_REVIEW list, and the review service's
purpose filter (`ORDER_PAYMENT`/`WALLET_CHARGE`) does not load them.
Card-to-card continue/receipt behavior is unchanged on both pre-invoices.

## Intentionally NOT implemented

Wallet payment for wallet top-up (a top-up can never be paid from the
wallet) or OTHER_PRODUCT, free (0-Toman) checkout, extra volume/time,
online gateways, Telegram Stars, representative debt / negative balance,
cashback, admin manual balance adjustment.
