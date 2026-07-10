# ZED_BOT extra time (Phase 17)

Phase 17 wires «خرید زمان اضافه ⏳» end-to-end: purchased days extend
the expiry of an EXISTING service — the existing panel account and existing
`Service` row are updated in place, **never a new Service**. Payment goes
through card-to-card (Phase 7/8 receipt review) or the wallet (Phase 15),
both unchanged. `OrderType.EXTRA_TIME` already existed — **no migration**.

> **Phase 18.1 entry-point change:** the button is **no longer on the main
> menu**. It now lives on the selected-service detail page inside
> «سرویس‌های من 🛍» and routes straight into this flow's existing
> `user:et:svc:<serviceSid>` step (skipping the eligible-services list).
> The old entry `CB.USER_EXTRA_TIME` (`user:extra_time`, ButtonText key
> `extra_time`) and its eligible-list handler **remain registered** for old
> Telegram messages that still show the removed main-menu button — the flow
> itself is unchanged.

Source: `apps/bot/src/services/extra-time.service.ts`, flow in
`apps/bot/src/handlers/user-extra-time/`, wallet path in
`wallet-payment.service.ts`, adapter extension in `packages/panel-adapters`.

## Eligible services

Owned, `deletedAt` null, status in {ACTIVE, EXPIRED, LIMITED, DISABLED}
(never CREATING/FAILED/DELETED — EXPIRED is deliberately INCLUDED because
extra time extends from *now* for expired services), **finite expiry only**
(`expiresAt` not null — adding days to a never-expiring service would
DOWNGRADE it to a finite expiry, so those are excluded and stale selections
rejected with «این سرویس زمان نامحدود دارد و نیاز به خرید زمان اضافه
ندارد.»), panel ACTIVE. 5 per page, newest first. Empty → «سرویسی برای
خرید زمان اضافه وجود ندارد.» + buy/menu buttons.

## Packages

No explicit package kind exists, so **Phase 17 treats active same-panel
`SERVICE_PRODUCT`s with `durationDays > 0` and `priceToman > 0` (active
category, group-visible) as extra-time packages**, ordered by duration,
price, displayOrder. **A package's `volumeGb`, if set, is IGNORED by the
time calculation** — extra time never adds volume (documented per spec).
Nothing hardcoded/seeded; a future `product.intent` migration can refine
this. Cross-panel products, duration-less products and OTHER_PRODUCTs never
appear. Empty → «بسته‌ای برای خرید زمان اضافه این سرویس موجود نیست.»

## Pre-invoice

«پیش‌فاکتور خرید زمان اضافه ⏳» with نوع, service username, بسته زمان, مدت
اضافه, پنل, دسته‌بندی, price/discount lines, wallet balance (+ insufficient
notice). Buttons: «ادامه و انتخاب روش پرداخت ✅», «پرداخت با کیف پول 🏦»
(only when the balance covers the amount), discount enter/clear, back, main
menu. **Nothing is written** until continue or wallet confirmation.
Discounts use PURCHASE semantics (PURCHASE/BOTH accepted, RENEWAL-only
rejected), revalidated at continue/confirm and finalized only after
successful payment; other flows' discount behavior untouched.

## Card-to-card path

Continue creates the PENDING `CheckoutSession`: `purpose ORDER_PAYMENT`,
`orderType EXTRA_TIME`, `serviceId`, `productId`, price/discount fields,
snapshot = normal product snapshot + `flowType: "EXTRA_TIME"`,
`extraTimeTargetServiceId/Username`, `extraTimeDays`, target expiry; older
PENDING checkouts of the same service are cancelled. Phase 7 method
selection, receipt upload and Phase 8/8.1 review run unchanged; approval
creates the PAID Order (with `serviceId`) and dispatches
`executeExtraTimeOrder`.

## Wallet path

`payExtraTimeDraftWithWallet` extends the shared Phase 15 atomic
transaction (not duplicated): one transaction settles the PAID checkout +
APPROVED `PAY_WITH_WALLET` payment + PAID EXTRA_TIME order, deducts the
balance, writes the SPEND `WalletTransaction` and finalizes the discount.
`Payment.idempotencyKey = wallet:<userId>:extra-time:<draftNonce>` —
double clicks/concurrent duplicates return the first settled result.
Execution runs immediately afterwards.

## Apply method — ADD_PURCHASED_DAYS_TO_CURRENT_EXPIRY

`newExpiresAt = (current expiry while still in the future, else now) +
purchasedDays`. **Volume and usage are untouched** — no reset call, no
quota change (the current `data_limit` is sent back unchanged).
`durationDays` is recomputed as days from `startsAt` to the new expiry.
Status after success: exhausted finite traffic stays **LIMITED**, everything
else becomes **ACTIVE** (this is how EXPIRED/DISABLED services come back).

## Adapter status

`PanelAdapter.addServiceTime({username, totalBytes (current quota passed
through; null = unlimited), expiresAt (new, non-null), …})`. **Marzban
implemented** on documented endpoints: `GET /api/user/{username}` then
`PUT /api/user/{username}` with the NEW `expire`, the UNCHANGED
`data_limit` and the unchanged proxies/inbounds — **no `/reset` call**
(extra time never wipes traffic accounting), username never changes.
**XUI** stays a safe TODO (`"XUI extra time is not implemented yet."`,
`TODO(xui-extra-time)`) — paid XUI orders fail safely and refund.

## Execution, refund, idempotency

`executeExtraTimeOrder(orderId)`: `PAID → PROVISIONING` (CAS claim) → panel
update → one transaction updating the existing Service (new expiry +
recomputed durationDays + computed status; volume/usage only when the panel
reported values; links only when returned; `lastSubscriptionUpdateAt`),
Order → COMPLETED, and a `ServiceEventLog` row (`eventType
EXTRA_TIME_APPLIED`, metadata orderId/addedDays/oldExpiresAt/newExpiresAt —
plain-string eventType, no migration). The event row is the apply-once
guard; persistence retries once (9.1 rule). Any failure (missing/
never-expiring/foreign target, inactive panel, adapter error, zero days) →
Order FAILED + the shared idempotent wallet refund. Success: «زمان سرویس
شما با موفقیت افزایش یافت ✅» (+username, زمان اضافه‌شده, تاریخ انقضای
جدید, لینک when stored). Failure: «پرداخت زمان اضافه شما تایید شد ✅ / اما
افزایش زمان سرویس با خطا مواجه شد. / مبلغ پرداختی به کیف پول شما برگشت
داده شد.» The user is never left charged without applied time or a refund.

## Intentionally NOT implemented

Enable/disable, change link/note, transfer, rating, other products, online
gateways, Telegram Stars, admin service management, a `product.intent`
package-kind field (documented future migration), XUI extra time (safe
TODO), free (0-Toman) checkout.
