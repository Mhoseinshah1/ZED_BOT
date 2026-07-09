# ZED_BOT service renewal (Phase 12)

Phase 12 wires «تمدید سرویس ♻️» end-to-end: the user renews an EXISTING
service with a plan from the same panel, pays through the unchanged Phase
7/8 card-to-card path, and after receipt approval the existing panel account
and existing `Service` row are updated in place. **A renewal never creates a
new Service.** Before payment nothing is touched — the `CheckoutSession`
(orderType `SERVICE_RENEWAL`) is the only write of the browse flow.

Source: `apps/bot/src/handlers/user-renewal/`,
`apps/bot/src/services/{renewal-checkout,service-renewal}.service.ts`,
adapter extension in `packages/panel-adapters`.

> **Phase 15 update:** the renewal pre-invoice offers «پرداخت با کیف پول
> 🏦» when the wallet balance covers the amount — settles instantly and
> runs this same renewal pipeline (`docs/wallet-payment-phase15.md`).

> **Phase 13 update:** the read-only wallet page
> (`docs/user-wallet-phase13.md`) now shows the user's balance and latest
> wallet transactions — renewal/provisioning refunds are directly visible
> there.

## User flow

`user:renew` lists renewable services (5/page, newest first): owned,
`deletedAt` null, status in {ACTIVE, EXPIRED, LIMITED, DISABLED} (never
CREATING/FAILED/DELETED), panel exists and is ACTIVE. Empty → «سرویسی برای
تمدید وجود ندارد.» + buy/menu buttons. Selecting a service
(`user:renew:svc:<sid>`) shows its summary (username, name, status, expiry
+ remaining days, volume, panel) above the renewal plans; plans
(`user:renew:plan:<svcSid>:<prodSid>`) are active `SERVICE_PRODUCT`s of the
**same panel** with an active category, visible to the user's group,
ordered by category order / displayOrder / price. Panel `isVisible` is
deliberately NOT required for renewal — owners may renew on a panel hidden
from new buyers, as long as it is ACTIVE. No plans → «پلنی برای تمدید این
سرویس موجود نیست.»

The renewal pre-invoice shows نوع «تمدید سرویس», the service username, the
plan/panel/category, مدت/حجم, price, wallet balance and discount lines,
with «ادامه و انتخاب روش پرداخت ✅» / «وارد کردن کد تخفیف 🎁» / «بازگشت» /
«منوی اصلی». Every route re-validates ownership
(`service.userId === ctx.dbUser.id`), renewability and that the plan still
belongs to the service's panel — session state is never trusted.

## Discount

`validateDiscountCode` gained a `purpose` parameter (`PURCHASE` default /
`RENEWAL`): renewal accepts codes with `appliesTo` RENEWAL or BOTH and
rejects PURCHASE-only codes («این کد تخفیف برای تمدید سرویس قابل استفاده
نیست.») — and vice versa for purchases (unchanged behavior). All other
rules (active/window/limits/groups/per-user) apply as before; usage is
still finalized only on receipt approval (Phase 8), never during preview.

## CheckoutSession (created only on continue)

`purpose ORDER_PAYMENT`, `orderType SERVICE_RENEWAL`, `serviceId` = target
service, `productId` = renewal plan, price/discount fields, `status
PENDING`, standard expiry. Older PENDING checkouts of the same user+service
are cancelled first. The snapshot extends the normal product snapshot with:
`renewalTargetServiceId`, `renewalTargetUsername`,
`renewalMethod: "ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD"`,
`renewalTargetStatus`, `renewalTargetExpiresAt`,
`renewalTargetRemainingBytes`, `renewalTargetVolumeBytes`. Payment method
selection, receipt upload and admin review are the untouched Phase 7/8
surfaces; Phase 8 approval copies `checkout.serviceId` onto the Order (the
schema already supports it), creates the Order `PAID`, and finalizes the
discount idempotently.

## Default renewal method — ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD

The only method in this phase (admin-configurable methods come later):

- **Time**: base = current `expiresAt` while still in the future, otherwise
  now; plan `durationDays > 0` extends from that base; `durationDays = 0`
  keeps the existing expiry (null stays null = unlimited).
- **Volume**: plan `volumeGb = 0` → unlimited (total/remaining stored as
  `0n`). Otherwise the new quota = previous remaining (counted only for
  previously-limited services; unlimited or exhausted contributes 0) +
  purchased bytes; `newTotal = newRemaining`, usage restarts at **0** in
  both the DB and the panel.

`Service.durationDays` is recomputed as days from `startsAt` to the new
expiry (0 when unlimited).

## Adapter: renewServiceAccount

`renewServiceAccount({ username, totalBytes (null = unlimited), expiresAt
(null = never), note?, subscriptionBaseUrl? })` — never deletes/recreates
the account, never changes the username, never fakes success.

- **Marzban (implemented)**, documented endpoints only: `GET
  /api/user/{username}` (existence + current proxies/inbounds), `POST
  /api/user/{username}/reset` (zero the usage — the method starts a fresh
  quota), then `PUT /api/user/{username}` with the new `data_limit`
  (bytes, 0 = unlimited), `expire` (unix seconds, 0 = never), `status:
  "active"` and the **unchanged** proxies/inbounds. If the reset succeeds
  but the modify fails, nothing was upgraded — the order fails and refunds
  (the account merely has zeroed usage; logged for review). 404 → «Panel
  account not found.»
- **XUI/Sanaei — safe TODO**: `ok=false, "XUI renewal is not implemented
  yet."` (`TODO(xui-renewal)`, same reason as create/sync: the
  token-authenticated endpoint surface needs the Sanaei reference). Paid
  XUI renewals fail safely and refund.

## Renewal execution (after approval)

The receipts handler dispatches by order type: `SERVICE_PURCHASE` keeps the
Phase 9 provisioning unchanged; `SERVICE_RENEWAL` runs
`executeRenewalOrder(orderId)`:

`PAID → PROVISIONING` (compare-and-set claim) → panel renewal → in ONE
transaction: the existing Service updated in place (status ACTIVE, computed
volume/remaining, `usedBytes` from the panel (else 0), expiry, recomputed
durationDays, subscription/config links only when returned,
`lastSubscriptionUpdateAt = now`), Order → COMPLETED, and a
`ServiceEventLog` row (`eventType RENEWAL_APPLIED`, `metadata.orderId`).

**Idempotency**: the event log row is the guard — a re-run finds it,
repairs the order to COMPLETED if needed and returns the service without
re-applying anything; the claim CAS blocks concurrent double-execution; DB
persistence after panel success retries once (Phase 9.1 rule) before
failing.

**Failure** (missing service, inactive panel, adapter error, exhausted
persistence retry): Order → FAILED + the shared idempotent wallet refund
(`REFUND`/`SYSTEM`/`REFUND_PROVISIONING_FAILED`); the user is never left
charged without a renewal or a refund. User failure text: «پرداخت تمدید شما
تایید شد ✅ / اما تمدید سرویس با خطا مواجه شد. / مبلغ پرداختی به کیف پول
شما برگشت داده شد.» Success: «سرویس شما با موفقیت تمدید شد ✅» + username,
حجم جدید, تاریخ انقضای جدید, لینک اشتراک when stored. Admin sees «سرویس
تمدید شد ✅» / «تمدید سرویس ناموفق بود و مبلغ به کیف پول کاربر برگشت داده
شد.» Raw adapter errors stay in logs; links are never logged.

## Intentionally NOT implemented

Extra volume/time, location change, enable/disable, change link/note,
transfer, delete/revoke, rating, QR, admin service management,
admin-configurable renewal methods (only ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD
exists), XUI renewal (safe TODO), online gateways, Telegram Stars, web
panel, mini app.
