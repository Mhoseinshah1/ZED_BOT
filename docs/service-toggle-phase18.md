# ZED_BOT service enable/disable (Phase 18)

Phase 18 lets a user switch their OWN service off («خاموش کردن سرویس ⏸»)
and back on («روشن کردن سرویس ▶️») from the «سرویس‌های من 🛍» detail page.
The EXISTING panel account and EXISTING `Service` row change **status only**
— no new Service, no `CheckoutSession`/`Payment`/`Order`/`WalletTransaction`,
no username/expiry/volume change and **never** a traffic reset.

Source: `apps/bot/src/services/service-toggle.service.ts`, buttons/flow in
`apps/bot/src/handlers/user-services/{services.handler,service-views}.ts`,
adapter extension in `packages/panel-adapters`.

## Callbacks

| Callback | Action |
| --- | --- |
| `user:svc:disable:<sid>` | Disable confirmation screen (no panel call yet) |
| `user:svc:disable:<sid>:yes` | Execute disable |
| `user:svc:enable:<sid>` | Enable confirmation screen (no panel call yet) |
| `user:svc:enable:<sid>:yes` | Execute enable |

`<sid>` is the usual 8-char uuid prefix, resolved owner-scoped
(`getToggleableServiceByShortId`) — unknown/ambiguous/deleted/foreign ids all
answer «مورد یافت نشد.».

## Buttons on the service detail page

`availableToggleAction(service, panelStatus)` decides which (single) toggle
button renders:

- status ACTIVE or LIMITED + panel ACTIVE → «خاموش کردن سرویس ⏸»
- status DISABLED + panel ACTIVE + **not expired** → «روشن کردن سرویس ▶️»
- CREATING / FAILED / EXPIRED / DELETED, non-ACTIVE panel, or missing panel
  username → **no toggle button**

Every existing detail button (refresh/link/configs/back) is unchanged. The
schema's per-panel `userCanDisableService`/`userCanEnableService` flags are
NOT consulted in Phase 18 (they default to false and would hide the feature
everywhere); wiring them up is a possible later refinement.

> **Phase 18.1:** the detail page also gained «خرید حجم اضافه ➕»/«خرید
> زمان اضافه ⏳» (moved off the main menu; they route into the existing
> Phase 16/17 flows). All detail-page action visibility — the toggle plus
> both purchase buttons — is now resolved with one panel read by
> `resolveServiceDetailActions` in `user-services.service.ts`, which
> replaced this module's single-purpose `resolveToggleAction` helper
> (`availableToggleAction` is unchanged).

## Confirmation first — the panel is never called before «yes»

Disable: «آیا از خاموش کردن این سرویس مطمئن هستید؟» plus the warning
«⚠️ تا زمانی که سرویس خاموش باشد، امکان اتصال وجود ندارد.» Enable: «آیا از
روشن کردن این سرویس مطمئن هستید؟» Buttons: «بله، خاموش کن ⏸»/«بله، روشن کن
▶️» → the `:yes` callback, «انصراف» → back to the detail view. The ask step
re-validates eligibility so stale buttons answer a safe toast and re-render.

## Eligibility (`toggleEligibility`)

- **Disable**: owned, `deletedAt` null, status ACTIVE or LIMITED, panel
  ACTIVE, panel username present.
- **Enable**: owned, `deletedAt` null, status DISABLED, panel ACTIVE, panel
  username present, and **not expired** — an expired service answers «این
  سرویس منقضی شده و ابتدا باید تمدید شود.» (renewal is the correct path;
  enabling would fake activity). `expiresAt` null (never expires) is fine.
- Everything else → «امکان تغییر وضعیت این سرویس وجود ندارد.»

## Adapter — `setServiceStatus({username, enabled, subscriptionBaseUrl?})`

**Marzban** (documented endpoints only): GET `/api/user/{username}` → PUT
`/api/user/{username}` sending the existing proxies/inbounds/data_limit/
expire back **unchanged** with only `status: "active" | "disabled"` new. No
`/reset` call ever, username never changes, missing account → «Panel account
not found.». **XUI** stays a safe TODO (`"XUI service status change is not
implemented yet."`, `TODO(xui-toggle)`). No fake success anywhere.

## Execution (`toggleServiceStatus(userId, serviceId, action)`)

Re-reads the service scoped to `userId` (+panel), validates eligibility,
updates the **panel first**, and only then, in one transaction, the Service
row + a `ServiceEventLog` entry (`SERVICE_DISABLED_BY_USER` /
`SERVICE_ENABLED_BY_USER`, metadata `action`/`previousStatus`/`newStatus` —
plain-string eventType, no migration). Service update: DISABLE → DISABLED;
ENABLE → LIMITED when finite traffic is exhausted, else ACTIVE;
usedBytes/remainingBytes/expiresAt/links refresh **only** when the adapter
returned them; `lastSubscriptionUpdateAt` = now.

- **Already in the desired state** (double click/stale button) → `{ok,
  alreadyDone: true}`, NO event log, user sees «وضعیت سرویس قبلاً همین حالت
  بوده است.»
- **Adapter failure** → DB row completely untouched, no event log, user sees
  «تغییر وضعیت سرویس با خطا مواجه شد. لطفاً بعداً دوباره تلاش کنید.» — the
  raw adapter error is only logged internally.
- **Concurrency**: besides the up-front check, the write is an `updateMany`
  filtered on the allowed previous statuses (DISABLE: ACTIVE/LIMITED;
  ENABLE: DISABLED) in the same transaction as the event log — a concurrent
  toggle can never double-apply or clobber a newer state; the loser re-reads
  and reports `alreadyDone` when the desired state was reached.
- **DB failure after panel success**: persistence retries once (Phase 9.1
  rule), then fails safely — a later toggle/refresh re-syncs from the panel.

Success: «سرویس با موفقیت خاموش شد ✅» / «سرویس با موفقیت روشن شد ✅», then
the refreshed detail view (with the opposite toggle button).

## Security

Owner-scoped resolution on every step; panel validated ACTIVE before any
call; raw panel errors/payloads never shown or logged with links; no
subscription/config links in logs; no payment-side rows are ever touched
(verified in tests: 0 Orders/Payments/CheckoutSessions/WalletTransactions).

## Intentionally NOT implemented

Change subscription link, change note, transfer, rating, admin service
management, online gateways, Telegram Stars, XUI toggle (safe TODO),
per-panel `userCanDisableService`/`userCanEnableService` gating, auto
re-enable, Phase 19+. (Extra volume/time buttons — absent from the detail
page in Phase 18 — were added there by Phase 18.1.)
