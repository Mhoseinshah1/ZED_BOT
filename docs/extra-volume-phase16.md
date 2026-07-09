# ZED_BOT extra volume (Phase 16)

Phase 16 wires «خرید حجم اضافه ➕» (new main-menu button, ButtonText key
`extra_volume`, callback `user:extra_volume`) end-to-end: purchased volume
is added to an EXISTING finite-volume service — the existing panel account
and existing `Service` row are updated in place, **never a new Service**.
Payment goes through card-to-card (Phase 7/8 receipt review) or the wallet
(Phase 15), both unchanged.

Source: `apps/bot/src/services/extra-volume.service.ts`, flow in
`apps/bot/src/handlers/user-extra-volume/`, wallet path in
`wallet-payment.service.ts`, adapter extension in `packages/panel-adapters`.

## Eligible services

Owned, `deletedAt` null, status in {ACTIVE, LIMITED} (never
CREATING/FAILED/DELETED/EXPIRED — Phase 16 stays strict), **finite volume
only** (`volumeBytes > 0` — extra volume is meaningless for unlimited
services, which are excluded up-front and rejected on stale buttons with
«این سرویس حجم نامحدود دارد و نیاز به خرید حجم اضافه ندارد.»), panel
ACTIVE. 5 per page, newest first. Empty → «سرویسی برای خرید حجم اضافه وجود
ندارد.» + buy/menu buttons.

## Packages

The product model has no explicit package kind, so **Phase 16 treats active
same-panel `SERVICE_PRODUCT`s with `volumeGb > 0` and `priceToman > 0` (in
an active category, visible to the user's group) as extra-volume packages**
— ordered by volume, price, displayOrder. Nothing is hardcoded or seeded
and no admin-UI/schema change was needed; a future `product.intent`
migration can refine this. Cross-panel products and OTHER_PRODUCTs never
appear. Empty → «بسته‌ای برای خرید حجم اضافه این سرویس موجود نیست.»

## Pre-invoice

«پیش‌فاکتور خرید حجم اضافه ➕» with نوع, service username, بسته حجم, حجم
اضافه, پنل, دسته‌بندی, price/discount lines, wallet balance (+ insufficient
notice). Buttons: «ادامه و انتخاب روش پرداخت ✅», «پرداخت با کیف پول 🏦»
(only when `finalPriceToman > 0` and the balance covers it), discount
enter/clear, back, main menu. **Nothing is written** until continue or
wallet confirmation. Discounts use **PURCHASE** semantics (PURCHASE/BOTH
codes accepted, RENEWAL-only rejected), revalidated at continue/confirm and
finalized only after successful payment — the existing purchase/renewal
discount behavior is untouched.

## Card-to-card path

Continue creates the PENDING `CheckoutSession`: `purpose ORDER_PAYMENT`,
`orderType EXTRA_VOLUME`, `serviceId`, `productId`, price/discount fields,
snapshot = normal product snapshot + `flowType: "EXTRA_VOLUME"`,
`extraVolumeTargetServiceId/Username`, `extraVolumeGb`, target
volume/remaining state; older PENDING checkouts of the same service are
cancelled. Phase 7 method selection, receipt upload, and Phase 8/8.1
review/confirmation run unchanged; approval creates the PAID Order (with
`serviceId`) and dispatches `executeExtraVolumeOrder`.

## Wallet path

The shared Phase 15 atomic transaction was extended (not duplicated):
`payExtraVolumeDraftWithWallet` re-validates service/package/discount, then
one transaction creates the PAID checkout + APPROVED `PAY_WITH_WALLET`
payment + PAID EXTRA_VOLUME order, deducts the balance, writes the SPEND
`WalletTransaction` and finalizes the discount.
`Payment.idempotencyKey = wallet:<userId>:extra-volume:<draftNonce>` —
double clicks/concurrent duplicates return the first settled result.
Execution runs immediately afterwards.

## Apply method — ADD_PURCHASED_VOLUME_TO_CURRENT_REMAINING

`newTotal = newRemaining = max(current remaining, 0) + volumeGb × 1024³`;
usage resets to **0** (DB and panel); **expiry, durationDays and startsAt
are unchanged** — extra volume never extends time. LIMITED services become
ACTIVE after the volume lands; ACTIVE stays ACTIVE.

## Adapter status

`PanelAdapter.addServiceVolume({username, totalBytes (non-null), expiresAt
(passed through unchanged), note?, subscriptionBaseUrl?})`. **Marzban**
delegates to the same documented endpoints/semantics as renewal (GET user →
POST reset → PUT data_limit/expire/status-active, proxies/inbounds/username
untouched). **XUI** stays a safe TODO (`"XUI extra volume is not
implemented yet."`, `TODO(xui-extra-volume)`) — paid XUI orders fail safely
and refund. No fake success anywhere.

## Execution, refund, idempotency

`executeExtraVolumeOrder(orderId)`: `PAID → PROVISIONING` (CAS claim) →
panel update → one transaction updating the existing Service (status
ACTIVE, new totals, usage 0, links only when returned,
`lastSubscriptionUpdateAt`), Order → COMPLETED, and a `ServiceEventLog` row
(`eventType EXTRA_VOLUME_APPLIED` — the column is a plain string, so no
enum/migration; metadata carries orderId/addedVolumeGb/addedBytes). The
event row is the apply-once guard; persistence after panel success retries
once (9.1 rule). Any failure (missing/unlimited/foreign service, inactive
panel, adapter error, zero volume, exhausted retry) → Order FAILED + the
shared idempotent wallet refund. Success: «حجم سرویس شما با موفقیت افزایش
یافت ✅» (+username, حجم اضافه‌شده, حجم جدید, انقضا بدون تغییر, لینک when
stored). Failure: «پرداخت حجم اضافه شما تایید شد ✅ / اما افزایش حجم سرویس
با خطا مواجه شد. / مبلغ پرداختی به کیف پول شما برگشت داده شد.» The user is
never left charged without applied volume or a refund.

## Intentionally NOT implemented

Extra time, enable/disable, change link/note, transfer, rating, other
products, online gateways, Telegram Stars, admin service management, a
`product.intent` package-kind field (documented future migration), XUI
extra volume (safe TODO), free (0-Toman) checkout.
