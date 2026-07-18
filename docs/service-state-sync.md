# Worker Service-State Synchronization (Phase 1)

`apps/worker/src/notifications/service-sync.ts` (+ `panel-adapter-factory.ts`,
`circuit-breaker.ts`). Refreshes stored `Service` usage/status/expiry from the
panels so notification rules work off fresh data. **Read-only** against the
panel: it never mutates the panel, never renews/deletes/disables anything, never
touches orders/payments, and never disables a panel.

## Per-panel sequence (`syncPanelServices`)

1. **Fail closed on Redis loss** — `redis.ping()`; without a working lock backend
   we cannot guarantee a single sync per panel, so we skip rather than risk
   concurrent writers (`skipped: redis-unavailable`).
2. **Circuit breaker** — skip a panel whose failure counter is at/over the
   threshold (`skipped: breaker-open`).
3. **Per-panel lock** — `SET NX PX` on `zedbot:panel-sync:<panelId>` (120 s TTL,
   self-freeing on crash). Contention ⇒ `skipped: lock-contended`.
4. **Panel state** — skip missing/inactive panels.
5. **Read** — one of:
   - **Bulk** (adapters exposing `listServiceAccounts`, e.g. XUI): ONE inventory
     call, matched locally by `username`. A username with no client is *positive
     absence* — the row is left untouched (never marked deleted).
   - **Per-user** (Marzban, no bulk endpoint): a `notification_sync_concurrency`
     (default 3) bounded loop of `getServiceAccount`, with a small inter-batch
     delay so the panel is not hammered.
6. **Safe update** (`buildServiceSyncUpdate`) — only fields the panel actually
   reported are written; unlimited quota is stored as `0n`; subscription
   url/token/config-links are never blanked; `lastSubscriptionUpdateAt` is
   stamped only when something authoritative was mapped. A failed read returns
   `null` ⇒ the row is untouched (**never guess**).
7. **Breaker bookkeeping** — a readable inventory (or any definite panel answer)
   clears the breaker; a panel-wide read failure trips it.

`runServiceStateSync` groups all sync-eligible services by panel (one `distinct`
query) and syncs each panel sequentially — concurrency lives *within* a panel;
one failing panel never aborts the sweep.

## Circuit breaker (`circuit-breaker.ts`)

A Redis counter `zedbot:panel-breaker:<panelId>`: `INCR` + `EXPIRE 600s` on
failure, `DEL` on success. `isPanelBreakerOpen` returns true at count ≥ 5. On a
Redis *read* error it returns `false` (not open) so a Redis blip cannot wedge
sync. Recovery is automatic: the first healthy read after the 10-minute decay
window (or after any success) clears the counter.

## Stale-state contract

The notification scan never generates or delivers from stale state. When a
service's state is stale:

1. the traffic/status rules skip it (freshness gate);
2. the next scheduled sync (every 15 min) refreshes it;
3. the next scan (every 5 min) re-evaluates it once fresh;
4. traffic/expiry are **never guessed** — a failed panel read leaves the last
   stored values in place.

## Adapter bulk contract

`PanelAdapter.listServiceAccounts?(input?)` (optional):
`Promise<GetServiceAccountResult[] | null>` — a full inventory read, `null` on
auth/read failure. XUI implements it via one `listClients` call; Marzban leaves
it `undefined`, so the worker falls back to the bounded per-user path. Legacy
per-inbound XUI clients (email `username-<inboundId>`) are simply left unsynced
in the bulk path rather than corrupted — safe-by-untouched.

## Logging

Every log carries only a short (8-char) panel id and safe counts/codes — never a
username, subscription URL, token, or panel credential.

## Reuse by customer win-back (Phase 3)

Customer win-back is a **negative assertion** — it targets customers with NO
usable paid service — so it depends on fresh state. It reuses this same machinery
rather than adding a second sync: `classifyPaidServiceForWinback` treats a paid
service whose panel-backed state is older than `serviceStateMaxAgeMinutes`
(default 20) as `SERVICE_STATE_UNCERTAIN`; the win-back scan then enqueues a
**priority `enqueuePanelSync`** for that panel and skips the candidate, and a later
retention scan re-evaluates once the state is fresh. A future expiry / unlimited
service always blocks win-back regardless of freshness (owning a service is not a
negative assertion); only the "expired/past-expiry" evidence needs freshness. A
panel being unreachable therefore never causes a "guess" of inactivity — the
candidate simply waits.
