# Service sync architecture (service-live-sync phase)

Whenever a user opens a service detail page, the bot synchronizes that
service from its VPN panel **before** rendering — the page shows live panel
state, not whatever happened to be stored. Manual refresh
(«بروزرسانی اطلاعات ♻️») stays available and always forces a sync; the
automatic path complements it, it does not replace it.

Source:
`apps/bot/src/services/service-sync.service.ts` (sync engine + display
wrapper), `apps/bot/src/handlers/user-services/services.handler.ts`
(triggers), `packages/panel-adapters/src/core/derived-reads.ts` +
the adapters (unified read surface).
Tests: `apps/bot/tests/service-live-sync.test.ts` (this phase),
`xui-lifecycle.test.ts` / `marzban-provisioning.test.ts` (adapter reads).

## Sync lifecycle

```
User opens service (user:svc:view:<sid>)
        │
        ▼
Load Service row (owner-scoped)
        │
        ▼
Freshness TTL check ──── fresh (synced < SERVICE_SYNC_TTL_SECONDS ago)
        │ stale                    └─► render stored row (no panel call)
        ▼
syncServiceFromPanel  ── bounded by SERVICE_SYNC_DISPLAY_TIMEOUT_MS
  ├─ per-service Redis lock (same mutex as mutations)
  ├─ buildAdapterForPanel(panel)   ← detect panel adapter
  ├─ adapter.getServiceAccount()   ← request latest info (read-only)
  ├─ normalize (GetServiceAccountResult)
  └─ prisma.service.update(...)    ← update local Service data
        │
        ▼
Render service detail (fresh row, or stored row + Persian fallback line)
```

Trigger points:

1. **Service detail open** — always (subject to the TTL).
2. **«سرویس‌های من» list open** — only when the operator sets
   `SERVICE_LIST_SYNC_ENABLED=true` (each page row synced concurrently,
   each bounded by the same display budget; failures keep the stored row).
3. **Manual refresh** — unchanged: always calls the sync engine directly,
   bypassing the TTL, with its own toast messages.

## Layering / adapter responsibilities

```
services.handler.ts            triggers + rendering only (no panel logic)
        │
ServiceSyncService             service-sync.service.ts
  syncServiceForDisplay        TTL cache, display budget, fallback texts
  syncServiceFromPanel         lock, load, adapter call, row update, logs
        │
PanelAdapter (contract)        packages/panel-adapters
  syncService()                full normalized snapshot
  getServiceStatus()           ┐
  getTrafficUsage()            │ projections of ONE getServiceAccount
  getExpiry()                  │ read (core/derived-reads.ts) - a panel
  getSubscriptionInfo()        ┘ field is NEVER invented (null = unknown)
        │
  MarzbanAdapter               GET /api/user/{username} (bearer token)
  XuiAdapter (Sanaei/3X-UI)    GET /panel/api/clients/list (+ links/{email})
```

No panel-specific logic lives in Telegram handlers: handlers call the sync
service; the sync service talks to the adapter contract; each adapter owns
its panel's HTTP shape.

### Marzban read

Auth via the documented OAuth2 password-grant token endpoint, then
`GET /api/user/{username}`. Normalized fields: panel `status` string →
`active/disabled/expired/limited` (anything else = `unknown`, stored state
kept), `used_traffic` → usedBytes, `data_limit` (0/null = unlimited) →
totalBytes/remainingBytes, `expire` (unix seconds, 0/null = never) →
expiresAt, `subscription_url` (+ **token extracted from the documented
`/sub/<token>` path shape** — this phase), `links` → configLinks,
`online_at`/`last_online` → lastConnectedAt. A documented 404 = positive
`notFound`.

### XUI / Sanaei (3X-UI, global-client API) read

Cookie or token auth, then the **complete client inventory**
(`/panel/api/clients/list`): positive-absence semantics — `notFound` only
when the full list was readable and no client matched. The service's client
is matched by exact email (global model) or the legacy `username-<id>`
labels (aggregated, read-only). Normalized fields: `enable`/expiry/limit →
derived status (`disabled`/`expired`/`limited`/`active` — 3X-UI has no
status string, the adapter computes it), `traffic.up + traffic.down` summed
→ usedBytes, `totalGB` (bytes; 0 = unlimited) → totalBytes/remainingBytes,
`expiryTime` (unix ms, 0 = never) → expiresAt, `subId` → subscriptionToken
(URL synthesized only when the panel row has a subscription base URL —
3X-UI's API does not report one), `traffic.lastOnline` → lastConnectedAt,
plus **live config links from `/panel/api/clients/links/{email}`**
(this phase; global-model clients only, strictly best-effort — a failed
links call never fails the sync and never clears stored links).

## What sync writes — and what it never touches

On a successful read the Service row gets: `status`, `usedBytes`,
`volumeBytes`/`remainingBytes`, `expiresAt`, `subscriptionUrl` (never
nulled), `subscriptionToken`, `configLinks` (only when non-empty),
`remoteMetadata`, `firstConnectedAt`/`lastConnectedAt`, and the freshness
stamp `lastSubscriptionUpdateAt`. A failed read writes **nothing**.

Sync **never** touches orders, payments, wallets or any financial record,
never mutates the panel, and never renews/creates/deletes anything.

## Cache strategy

- **Freshness TTL** (`SERVICE_SYNC_TTL_SECONDS`, default 60, `0` disables):
  the Service row itself is the cache and `lastSubscriptionUpdateAt` is the
  timestamp — distributed by construction (works across bot instances), no
  extra store, invalidated automatically because every successful sync
  restamps it. Rows synced within the TTL render without a panel call, so
  button-mashing the detail page costs one panel round-trip per minute.
- **Manual refresh bypasses the TTL** — an explicit press always re-syncs.
- **Per-service mutex**: sync shares the Redis lock all service mutations
  use, so a sync can never overwrite state written by a concurrent
  renewal/toggle with a stale panel snapshot.

## Fallback behavior (never technical errors)

The page **always renders**. When live data could not be delivered, the
stored values stay on screen with one safe Persian line appended:

| Condition | Outcome | Rendered line |
| --- | --- | --- |
| Row synced within the TTL | `cache-fresh` | — (data is fresh) |
| Panel answered, row updated | `synced` | — |
| Display budget exceeded (`SERVICE_SYNC_DISPLAY_TIMEOUT_MS`, default 8000) | `timeout` | آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود. بروزرسانی لحظه‌ای سرویس در دسترس نیست. |
| Panel unreachable / HTTP timeout / auth failed / panel row inactive | `panel-unavailable` | ارتباط با پنل سرویس برقرار نشد. لطفاً کمی بعد دوباره تلاش کنید. |
| Account positively missing on the panel | `not-found` | سرویس در پنل پیدا نشد. |
| Another operation holds the service lock, or any other failure | `locked` / `failed` | امکان دریافت اطلاعات لحظه‌ای سرویس وجود ندارد. آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود. |

On a display-budget cutoff the underlying sync is **not** cancelled: it
finishes in the background (it holds the per-service lock and never
rejects) and its result lands in the database for the next open.

Stack traces, provider payloads, tokens and passwords never reach the user;
adapter errors stay in server logs, already sanitized by the panel-adapters
error hygiene (`safeErrorText`, structured diagnostics).

## Security / logging

Sync logs carry **only** `serviceId`, `panelType`, `syncResult` and
`durationMs` (plus panelId on the engine's own start/success lines). Panel
tokens, passwords, cookies, authorization headers, subscription URLs and
config links are never logged — locked by the SECURITY test in
`service-live-sync.test.ts`.

## Supported panel fields

| Normalized field | Marzban | XUI/Sanaei |
| --- | --- | --- |
| status | panel `status` string | derived from `enable` + expiry + quota |
| expiresAt | `expire` (unix s; 0/null = never) | `expiryTime` (unix ms; 0 = never) |
| totalBytes | `data_limit` (0/null = unlimited) | `totalGB` (bytes; 0 = unlimited) |
| usedBytes | `used_traffic` | Σ `traffic.up + traffic.down` |
| remainingBytes | computed | computed |
| subscriptionUrl | `subscription_url` (absolutized) | synthesized from base URL + `subId` |
| subscriptionToken | extracted from `/sub/<token>` path | `subId` |
| configLinks | `links` | `/panel/api/clients/links/{email}` (live) |
| lastConnectedAt | `online_at`/`last_online` | `traffic.lastOnline` |

A field the panel does not report is returned as `null`/omitted — values
are never invented, and the stored value is preserved.

## Environment knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERVICE_SYNC_TTL_SECONDS` | `60` | freshness window; `0` = sync on every open |
| `SERVICE_SYNC_DISPLAY_TIMEOUT_MS` | `8000` | max time an open waits for the panel |
| `SERVICE_LIST_SYNC_ENABLED` | `false` | also live-sync the «سرویس‌های من» list page |
| `PANEL_HTTP_TIMEOUT_MS` | `10000` | per-request panel HTTP bound (pre-existing) |

## Shared read-and-sync primitive (feat/service-self-diagnostics)

`syncServiceFromPanel` and the new service self-diagnostics share ONE read
primitive so a diagnosis performs **at most one** authenticated panel account
read:

- `readServiceAccountAndSyncUnlocked(serviceId, userId)` — the lock-free core:
  owner-scoped load → panel-active gate → the single `getServiceAccount` read →
  update the Service row **only on success** → returns a rich, classified
  `PanelReadOutcome` (`read-ok` / `not-found` / `auth-failed` / `unreachable` /
  `panel-inactive` / `service-missing` / `read-error`, plus the sanitized
  diagnostic code).
- `syncServiceFromPanel` projects the outcome to the unchanged `SyncServiceResult`
  (backward compatible; the panel-connection-failed ops log still fires).
- `readServiceForDiagnostics(serviceId, userId)` takes the SAME per-Service lock
  and returns the rich `PanelReadOutcome` directly. Lock contention returns a
  synthetic `read-error` (diagnosticCode `locked`) the diagnostics layer maps to a
  retryable report — never an exception.

A failed read never overwrites the row. See `docs/service-self-diagnostics.md`.
