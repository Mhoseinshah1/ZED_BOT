# ZED_BOT service sync (Phase 11)

> The service-live-sync phase later made this sync AUTOMATIC on opening a
> service page (TTL cache, display budget, Persian fallbacks) and added the
> unified adapter sync surface — see `docs/service-sync-architecture.md`.
> This document describes the underlying Phase 11 engine, which is
> unchanged.

Phase 11 upgrades the «بروزرسانی اطلاعات ♻️» button from DB-only re-read to
a real **read-only panel sync**: the bot reads the account from the panel
and updates the stored `Service` fields. Nothing on the panel is ever
mutated, and no user actions (renew/extend/disable/delete/…) exist.

Source: `packages/panel-adapters` (`getServiceAccount`),
`apps/bot/src/services/{panel-adapter-factory,service-sync.service}.ts`,
refresh route in `apps/bot/src/handlers/user-services/services.handler.ts`.

## Adapter: getServiceAccount

`PanelAdapter.getServiceAccount({ username, subscriptionBaseUrl? })` →
`GetServiceAccountResult`: `ok`, `username`, normalized `status`
(`active/disabled/expired/limited/unknown`), `usedBytes`, `totalBytes`
(null = unlimited), `remainingBytes` (null = unlimited), `expiresAt`
(null = never), `subscriptionUrl`, `subscriptionToken`, `configLinks`,
`firstConnectedAt`, `lastConnectedAt`, internal-only `raw`/`errorMessage`.
Contract: optional fields are **omitted** when the panel didn't report them
(missing ≠ zero); adapters never throw for expected failures, never fake
success, never include credentials; `raw` never reaches users.

## Marzban mapping (implemented)

Documented `GET /api/user/{username}` after token auth. Defensive mapping:
`status` lowercased through {active, disabled, limited, expired}, anything
else (e.g. on_hold) → `unknown`; `used_traffic` → `usedBytes` (clamped ≥0);
`data_limit` 0/null → `totalBytes: null` (unlimited) else bytes;
`remainingBytes` = max(total − used, 0) or null when unlimited; `expire`
0/null → `expiresAt: null` else unix-seconds Date; relative
`subscription_url` absolutized via `subscriptionDomain`/baseUrl; `links`
filtered to non-empty strings; last connection parsed from
`online_at`/`last_online`/`last_connected_at` (first parseable wins,
otherwise omitted). A 404 returns `errorMessage: "Panel account not
found."` Missing optional fields never fail the sync.

## XUI / Sanaei (safe TODO)

`getServiceAccount` returns `ok=false, "XUI service sync is not implemented
yet."` — the token-authenticated read endpoint surface must come from the
Sanaei API reference (same reason as Phase 9 create). No fake success, no
guessing, no panel mutation; users keep seeing stored DB values.
`TODO(xui-sync)` marks the implementation point.

## Refresh behavior (user)

`user:svc:refresh:<sid>`: ownership re-validated via the userId-scoped
short-id lookup, then `syncServiceFromPanel(service.id, user.id)`:

- sync ok → answers «اطلاعات از پنل بروزرسانی شد.» and re-renders the
  updated detail;
- sync failed (panel inactive, unreachable, account missing, XUI TODO,
  credential error) → the row is untouched, answers «بروزرسانی از پنل
  ناموفق بود. آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود.» and re-renders
  the stored detail;
- unknown/foreign/deleted id → «مورد یافت نشد.»

Adapter error details never reach the user. The detail view gains one line,
«آخرین بروزرسانی», when `lastSubscriptionUpdateAt` is set; list/detail
remain read-only with the same buttons as Phase 10.

## Service fields updated on successful sync

`status` (only via the map — `unknown` keeps the stored status; CREATING/
FAILED are never set from a sync, and the bot does NOT locally auto-expire
an ACTIVE service past its expiresAt: the panel is the source of truth),
`usedBytes`, `volumeBytes`+`remainingBytes` (only when the panel reported a
limit; null → 0n = unlimited convention), `expiresAt` (only when reported —
null there explicitly means never expires), `subscriptionUrl` (never
overwritten with null/empty), `subscriptionToken`, `configLinks` (only when
the panel returned non-empty links), `firstConnectedAt` (only when still
null), `lastConnectedAt`, `lastSubscriptionUpdateAt = now`. `username` is
never changed.

## Security & logging

Owner-scoped everywhere (`service.userId === ctx.dbUser.id`); credentials
decrypted only inside the shared `panel-adapter-factory`; logs carry
serviceId/panelId/safe reason only — never passwords/tokens, subscription
URLs, config links or raw panel payloads.

## Intentionally NOT implemented (in Phase 11)

Extra volume/time, location change, enable/disable, transfer, delete,
note/link editing, rating, QR, XUI sync (safe TODO above), periodic
background sync (refresh is user-triggered only), admin service management.
(Renewal — with its own panel-mutating `renewServiceAccount` adapter method
— arrived in Phase 12: `docs/service-renewal-phase12.md`. Sync itself
remains strictly read-only.)
