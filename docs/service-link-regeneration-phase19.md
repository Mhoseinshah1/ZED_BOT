# ZED_BOT subscription link regeneration (Phase 19)

Phase 19 lets a user regenerate (revoke + reissue) their OWN service's
subscription link from the «سرویس‌های من 🛍» detail page. The EXISTING panel
account and EXISTING `Service` row are updated in place — no new Service, no
`CheckoutSession`/`Payment`/`Order`/`WalletTransaction`, no
username/expiry/volume change and **never** a traffic reset or a
delete/recreate.

Source: `apps/bot/src/services/service-link.service.ts`, buttons/flow in
`apps/bot/src/handlers/user-services/{services.handler,service-views}.ts`,
adapter extension in `packages/panel-adapters`.

## User flow

«سرویس‌های من 🛍» → select service → detail page → «تغییر لینک اشتراک 🔄»
→ confirmation → panel revoke → success with the NEW link.

| Callback | Action |
| --- | --- |
| `user:svc:regen_link:<sid>` | Confirmation screen (no panel call yet) |
| `user:svc:regen_link:<sid>:yes` | Execute regeneration |

`<sid>` is the usual 8-char uuid prefix, resolved owner-scoped
(`getLinkRegeneratableServiceByShortId`) — unknown/ambiguous/deleted/foreign
ids all answer «مورد یافت نشد.».

## Eligibility (`linkRegenerationEligibility`)

Button shown / action allowed only when: owned + `deletedAt` null (detail
route guarantees), status in {ACTIVE, LIMITED, DISABLED}, panel exists and
is ACTIVE, panel username present. **Never** for
CREATING/FAILED/DELETED/EXPIRED or an inactive/missing panel. Everything
else answers «امکان تغییر لینک اشتراک این سرویس وجود ندارد.» The flag is
part of `resolveServiceDetailActions` (one panel read for all detail-page
buttons); the ask **and** confirm routes both re-validate, so stale buttons
fail safely.

## Confirmation — the panel is never called before «yes»

«تغییر لینک اشتراک 🔄» + username (`<code>`), current status, expiry, then
«آیا از تغییر لینک اشتراک این سرویس مطمئن هستید؟» and the warning «⚠️ بعد از
تغییر لینک، لینک قبلی ممکن است دیگر کار نکند.» Buttons: «تایید تغییر لینک
✅» → `:yes`, «انصراف» → back to the detail view.

## Adapter — `regenerateSubscription({username, subscriptionBaseUrl?})`

Result shape matches the other account operations (ok, username?,
subscriptionUrl?, subscriptionToken?, configLinks?, usedBytes?, totalBytes?,
remainingBytes?, expiresAt?, status?, errorMessage?, raw?). Contract: never
fake success (returning the OLD link as "new" is forbidden), never
delete/recreate, never rename, never touch quota/expiry/usage.

- **Marzban — IMPLEMENTED** via the documented
  `POST /api/user/{username}/revoke_sub` endpoint (added as the minimal
  `MarzbanClient.revokeUserSubscription`): Marzban revokes the subscription
  (old link/proxy tokens stop working) and returns the user with the NEW
  `subscription_url`/`links`, which the adapter maps (plus the usual
  read-only sync fields). Nothing else is sent — no PUT, no `/reset`, no
  rename. 404 → «Panel account not found.»
- **XUI — safe TODO**: sanaei-api.txt gives no clear documented
  revoke/regenerate endpoint, so it returns
  `"XUI subscription regeneration is not implemented yet."`
  (`TODO(xui-regen-sub)`), and the DB stays untouched.

## Execution (`regenerateServiceSubscription(userId, serviceId)`)

Re-reads the service scoped to `userId` (+panel), validates eligibility,
calls the adapter, then **validates the success before any DB write**: the
panel must return at least one of subscriptionUrl/subscriptionToken/
configLinks, and if it echoes a username it must match — anything else is
treated as failure with zero DB mutation. On a validated success, ONE
transaction updates the existing Service (subscriptionUrl/subscriptionToken/
configLinks when returned; usedBytes/remainingBytes/expiresAt/status only
when returned safely — total volume is deliberately never written;
`lastSubscriptionUpdateAt` = now) and writes the `ServiceEventLog`:

- `eventType: SERVICE_SUBSCRIPTION_REGENERATED` (plain-string column — no
  enum, **no migration**)
- `metadata: { action: "REGENERATE_SUBSCRIPTION",
  previousHadSubscriptionUrl, newHasSubscriptionUrl }` — booleans only,
  **never** the old/new links or tokens.

Failure messaging: «تغییر لینک اشتراک با خطا مواجه شد. لطفاً بعداً دوباره
تلاش کنید.» — raw adapter errors never reach the user. Success: «لینک
اشتراک سرویس با موفقیت تغییر کرد ✅» + the new link in `<code>` + a back-to-
service button.

## Repeated clicks

Each confirmed click is an explicit user request, so confirming again
regenerates again — by design. The success screen replaces the confirmation
keyboard (killing post-completion double clicks), the callback is answered
promptly, and the DB always holds the last successful link; a mid-flight
double click can at worst revoke twice, never corrupt the row. No locks —
matching the existing service-action patterns.

## Security

Owner-scoped resolution on every route (`ctx.dbUser` required); panel
validated ACTIVE and status validated before any call; raw panel errors
never shown. Logs carry only serviceId/panelId/panelType/action/safe
errorMessage — **never** subscriptionUrl, subscriptionToken, configLinks or
credentials, and event-log metadata stores booleans, not links.

## Intentionally NOT implemented

Change note, transfer, rating, admin service management, payment/order/
wallet logic, online gateways, Telegram Stars, XUI regeneration (safe
TODO), QR regeneration, automatic link rotation, Phase 20+.
