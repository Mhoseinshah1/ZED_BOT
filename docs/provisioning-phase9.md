# ZED_BOT provisioning foundation (Phase 9)

Phase 9 turns a PAID `SERVICE_PURCHASE` Order (created by Phase 8 receipt
approval) into a real panel account plus an ACTIVE `Service` row — or, when
panel creation fails, FAILs the order and refunds the user's wallet.

**Core guarantee: the user is never left charged without either a service or
a refund.**

Source: `apps/bot/src/services/provisioning.service.ts`,
`packages/panel-adapters/src/` (adapter extension), integration in
`apps/bot/src/handlers/admin-receipts/receipts.handler.ts`.

## Status flow

```
PAID ──claim (CAS)──▶ PROVISIONING ──success──▶ COMPLETED (+ Service ACTIVE)
                              └──────failure──▶ FAILED (+ wallet refund)
```

- The `PAID → PROVISIONING` claim is a compare-and-set `updateMany`, so
  concurrent calls cannot double-provision.
- `FAILED` orders are NOT retried automatically in this phase (no retry UI).
- `PROVISIONING` orders answer «در حال انجام است» and are left alone.

## Trigger

After «تایید نهایی ✅» approves a receipt (Phase 8.1 confirmation still
applies) and the order type is `SERVICE_PURCHASE`, the handler shows the
admin «رسید تایید شد ✅ / Order ساخته شد. / ساخت سرویس شروع شد.» and calls
`provisionPaidOrder(order.id)` synchronously. `OTHER_PRODUCT` orders are
never provisioned — the admin sees «سفارش محصول ثبت شد و تحویل در فاز بعدی
انجام می‌شود.» and no `OtherProductOrder` row is created yet.

`provisionNextPaidOrders(limit)` (oldest PAID `SERVICE_PURCHASE` first,
capped at 50) exists as the future worker entry point; nothing schedules it
automatically in this phase.

## Adapter extension

`PanelAdapter` gains `createServiceAccount(input): Promise<CreateServiceAccountResult>`.
The input carries plain values only (username, note, `volumeBytes: bigint |
null`, `durationDays`, `expiresAt`, `templateUsername`,
`dataLimitResetStrategy`, `subscriptionBaseUrl`, `inboundIds`,
`protocolSettings`, `trafficResetCycle`) — the adapters package deliberately
never depends on the database layer, so the bot maps the order/user/
product/panel rows into this shape. Adapters never throw and NEVER fake
success; failures are `{ ok: false, errorMessage }` with credential-free
internal messages.

### Marzban (implemented)

Documented endpoints only: `POST /api/admin/token`, `GET
/api/user/{username}`, `POST /api/user`.

- Requires `panel.templateUsername` (an existing panel user). Its
  `proxies`/`inbounds` selection is copied with per-user secrets (`id`,
  `password`) stripped so Marzban generates fresh ones. Missing template →
  `"Marzban template/inbound settings are not configured."` — the order
  fails safely until the operator configures it.
- `data_limit` = bytes (0 = unlimited), `expire` = unix seconds (0 =
  never), `data_limit_reset_strategy` from `panel.resetStrategy` or the
  product's `trafficResetCycle` (`NO_RESET/DAY/WEEK/MONTH/YEAR` →
  `no_reset/day/week/month/year`), `status: "active"`.
- A `409` on create is recovered via `GET /api/user/{username}` (usernames
  are deterministic per order, so the account belongs to this very order —
  e.g. a previous attempt that crashed before recording the Service).
- Relative `subscription_url` values are absolutized with
  `panel.subscriptionDomain` (https:// assumed when no scheme) or the panel
  baseUrl; `links` become `configLinks`.

### XUI / Sanaei (safe TODO — not implemented)

Phase 4 never established the token-authenticated XUI endpoint surface and
the Sanaei API reference file is not part of the repository, so guessing
endpoints could create broken or orphaned accounts. Behavior:

- `panel.inboundIds` missing/empty → `"XUI inbound settings are not configured."`
- otherwise → `"XUI create-client is not implemented in this phase (safe
  TODO); no account was created."`

Either way the order FAILs and the user is refunded — success is never
faked. `TODO(xui-provisioning)` marks the implementation point.

## Username generation

`generatePanelUsername(telegramId, orderId)`:
`zed_<telegramId>_<orderShortId>` (first 8 hex chars of the order id),
lowercase, `[a-z0-9_]` only, deterministic per order. If the result would
exceed 32 chars, the telegramId's last 8 digits are used instead. Stored in
`Service.username` (globally unique — the order-id component guarantees it).
Configurable `usernamePatternType` settings are a later phase.

## Volume / duration conversion

- `volumeGb` 0 = unlimited → adapter gets `volumeBytes: null` (Marzban
  `data_limit: 0`); otherwise `volumeGb × 1024³` bytes.
- `durationDays` 0 = unlimited → `expiresAt: null` (Marzban `expire: 0`);
  otherwise now + days.
- Sold values come from the order snapshots
  (`volumeGbSnapshot`/`durationDaysSnapshot`/`productNameSnapshot`/
  `panelNameSnapshot`) with the live Product fields only as fallback.

## Service row (on success, same transaction as Order → COMPLETED)

`userId`, `orderId`, `panelId`, `productId`, `panelType`, `username`
(panel-confirmed), `note`, `status: ACTIVE`, `serviceLocation` (product's,
default MULTI_LOCATION), `productNameSnapshot`, `panelNameSnapshot`,
`volumeBytes`/`remainingBytes` (0n = unlimited per schema), `usedBytes: 0`,
`durationDays`, `startsAt: now`, `expiresAt` (nullable),
`subscriptionUrl`/`subscriptionToken`/`configLinks` when the panel returned
them. A Service is never duplicated for the same order (checked before
starting and re-checked inside the creation transaction).

## Refund on failure

One transaction in `failOrderWithRefund`:

1. `Order → FAILED` (+ `failureReason`, truncated internal text) — a CAS
   filtered on `PAID`/`PROVISIONING`; only the caller that flips creates the
   refund.
2. `User.balanceToman += order.finalPriceToman`,
   `User.totalRefundedToman += order.finalPriceToman`.
3. `WalletTransaction`: `type REFUND`, `source SYSTEM`,
   `reason "REFUND_PROVISIONING_FAILED"`, `relatedOrderId`,
   `relatedPaymentId`, `balanceBeforeToman`/`balanceAfterToman` from a fresh
   in-transaction read.

Idempotency: an existing refund transaction for the order short-circuits;
losing the FAILED CAS skips the refund; fully-discounted (0-Toman) orders
just FAIL without a zero transaction. If a Service exists, the failure path
is unreachable (service-exists wins first).

## Notifications

- Success → user gets the HTML service info («سرویس شما با موفقیت ساخته شد
  ✅» + name, username, حجم, مدت, انقضا, لینک اشتراک, کانفیگ‌ها — only
  fields that actually exist; with neither link nor configs it says
  «اطلاعات اتصال کامل از پنل دریافت نشد؛ لطفاً با پشتیبانی تماس بگیرید.»);
  admin sees «سرویس ساخته شد ✅».
- Failure → user gets «پرداخت شما تایید شد ✅ / اما ساخت سرویس با خطا مواجه
  شد. / مبلغ پرداختی به کیف پول شما برگشت داده شد.»; admin sees «ساخت سرویس
  ناموفق بود و مبلغ به کیف پول کاربر برگشت داده شد.» Raw adapter errors stay
  in the logs — never in Telegram messages.
- Logged: provisioning started (order/panel), success (service id), failure
  (+ refund flag). Never logged: passwords/tokens, subscription links,
  credential-bearing raw responses.

## Intentionally NOT implemented

Renewal, extra volume/time, location change, user service list,
enable/disable, service transfer, panel account deletion/update, XUI client
creation (safe TODO above), OtherProductOrder delivery, online gateways,
Telegram Stars, wallet payment, automatic retry of FAILED orders, a
provisioning queue/worker schedule (function exists, nothing calls it
periodically), panel capacity counters (`createdAccountsCount` /
`activeAccountsCount` stay untouched), and QR/usage sync.
