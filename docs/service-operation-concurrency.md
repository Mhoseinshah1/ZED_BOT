# Per-Service Operation Concurrency

Serializes every operation that mutates or reconciles an existing VPN
Service with a Redis distributed lock, and replaces reconciliation's
"any field changed" comparison with exact expected-state attribution.

## The original lost-update race

Order-level idempotency (CAS claims, event logs, unique payment keys)
protects one Order from applying twice. It does NOT protect two DIFFERENT
Orders targeting the SAME Service:

```
quota = 20 GB
Order A (+10 GB) reads remaining 20 -> computes 30 -> panel PUT 30
Order B (+10 GB) reads remaining 20 -> computes 30 -> panel PUT 30
```

Both PUTs succeed, both Orders complete, the user paid for 20 GB and got
10. The same shape affects renewal vs extras, extra time vs extra time,
toggles racing renewals, and sync overwriting freshly-persisted values
with a stale panel snapshot.

## The reconciliation attribution race

Startup reconciliation (docs/panel-database-reconciliation.md) classifies
a stale anchor-less order by comparing panel state with the stored
pre-state. Without serialization it could observe a change made by a LIVE
concurrent operation and classify the stale order as APPLIED - completing
it off someone else's mutation. And even without overlap, "the value
differs" never proves *whose* operation changed it.

## The lock

`apps/bot/src/services/service-lock.service.ts`.

- **Keys**
  - `zedbot:service-operation:<serviceId>` - every operation on an
    existing Service. Different Orders on one Service share this key by
    construction; different Services stay concurrent.
  - `zedbot:service-provisioning:<panelId>:<deterministicUsername>` -
    new-service provisioning and purchase reconciliation, before a
    Service row exists (the username is deterministic per order).
- **Ownership token**: 24 random bytes (`crypto.randomBytes`), hex. Never
  logged.
- **Acquisition**: one atomic `SET key token NX PX ttl`; bounded waiting
  (default 5s for paid operations, `0` for reconciliation) with
  150ms+jitter retries; `contended` and `unavailable` are distinct
  results.
- **TTL**: 90s. A pipeline performs at most ~4 panel HTTP calls, each
  AbortSignal-bounded at 10s, plus small DB transactions - worst case is
  well under 60s.
- **Heartbeat**: every 30s a compare-and-pexpire Lua renews the TTL only
  while the token still matches. A failed match marks the lock LOST and
  logs an error; pipelines check `isLost()` after the panel write and, if
  lost, do NOT persist - the order stays PROVISIONING and reconciliation
  (which runs under the same lock) settles it from panel truth. The
  heartbeat stops in `release()`.
- **Release**: compare-and-delete Lua
  (`if get(key)==token then del(key)`), called from the caller's
  `finally`. An expired owner can never delete a newer owner's lock.
  Release failures are logged and left to the TTL.
- **Command bound**: every lock command is additionally raced against a
  3s timeout - ioredis reconnect edge cases must never block a payment
  path.
- **Redis unavailable = fail closed**: no lock, no panel call, no money
  movement. Paid orders stay `PAID` and return the retryable Persian
  message; reconciliation defers (with a single availability probe per
  sweep so a backlog never multiplies the timeout). Connection errors are
  logged message-only - never the URL, host, or password.

## Protected operations

Every existing-Service mutation/reconciliation entry point acquires the
lock BEFORE reading any mutable state used for calculation, and holds it
across the panel request and local persistence:

| Operation | Entry point | Key |
|---|---|---|
| Service renewal | `executeRenewalOrder` | service |
| Extra volume | `executeExtraVolumeOrder` | service |
| Extra time | `executeExtraTimeOrder` | service |
| Enable/disable | `toggleServiceStatus` | service |
| Regenerate subscription | `regenerateServiceSubscription` | service |
| Sync from panel (writes Service state) | `syncServiceFromPanel` | service |
| New-service provisioning | `provisionPaidOrder` | provisioning |
| Startup reconciliation (renewal/extras) | `reconcileServiceMutation` | service |
| Startup reconciliation (purchase) | `reconcilePurchase` | provisioning |

Wrapper pattern (identical everywhere): pre-lock reads touch only
immutable inputs (order type, `serviceId`, the deterministic username);
after acquisition the body re-fetches Order/Service/Product/Panel from
scratch, re-checks anchors and statuses, claims the Order (CAS), reads or
mutates the panel, computes from fresh state, persists, and the lock is
released in `finally`.

### Paid-order contention behavior

If the lock cannot be acquired within the bounded wait, the order is left
`PAID`, nothing is refunded, the panel is not called, no ServiceEventLog
is written, and the caller receives the retryable Persian message
(«عملیات دیگری روی این سرویس در حال انجام است...»). With the lock backend
unavailable, the equivalent fail-closed message is returned
(«انجام عملیات سرویس موقتاً امکان‌پذیر نیست...»).

### Reconciliation contention behavior

Reconciliation uses `waitMs = 0`: contention means live work is in
flight, so the stale order defers immediately and retries on the next
sweep. Under the lock it re-fetches the order, re-checks the completion
anchor, and re-fetches the Service before classifying.

## Exact expected-state attribution

`classifyMutationState` (startup-recovery.service.ts) replaces the old
"any owned field changed => applied" rule. It recomputes each pipeline's
exact expected post-state with the pipeline's OWN calculation functions
from the stored pre-state and the order's immutable plan snapshot:

- **Extra volume**: `expected = max(remaining,0) + purchasedBytes`.
  APPLIED only if the panel limit equals `expected` AND the expiry is
  untouched. A different larger quota is UNKNOWN.
- **Extra time**: `expected = storedExpiry + purchasedDays` (derivable
  only while the stored expiry is still in the future - an expired base
  depended on the crashed attempt's wall clock). APPLIED only on an exact
  match within the 1.5s tolerance (Marzban stores whole seconds) AND an
  untouched limit. A later-but-different expiry is UNKNOWN.
- **Renewal**: expected quota/expiry from `calculateRenewal` (remaining +
  purchased, expiry base rules). APPLIED only when BOTH match the
  computed expectation.
- NOT_APPLIED requires the panel to match the pre-state exactly (both
  fields). Unreported fields, non-derivable expectations and degenerate
  `expected == pre` signatures are UNKNOWN and defer.

No schema change was needed: order rows already carry immutable
`volumeGbSnapshot`/`durationDaysSnapshot`, and the Service row still holds
the pre-mutation state precisely because the crash lost the update.

## Lock ordering and deadlocks

Each operation holds at most ONE distributed lock (a service key or a
provisioning key - never both), so no lock-ordering cycle can exist.
Database row locks are acquired strictly after the distributed lock and
follow the existing documented order (payment/user row before discount
row). The bounded TTL guarantees liveness even if an owner dies
mid-operation.

## Redis failure behavior (summary)

| Situation | Paid operation | Reconciliation |
|---|---|---|
| Lock contended | order stays PAID, retryable Persian message | defer, retry next sweep |
| Redis down | order stays PAID, fail-closed Persian message; panel never called | whole sweep defers via one availability probe |
| Ownership lost mid-operation | after panel write: do NOT persist, leave PROVISIONING for locked reconciliation | n/a (waits are 0) |

## Remaining limitations

- **Retry of contended paid orders is manual/asynchronous**: the order
  stays PAID and the user is asked to retry; nothing re-queues it
  automatically (consistent with the project's deferred-worker design for
  PAID orders).
- **XUI**: mutations remain unimplemented and are now blocked BEFORE
  payment by the capability model (docs/panel-capabilities.md);
  provisioning and purchase reconciliation run under the same locks as
  Marzban.
- **The lock serializes per service, not per panel**: a panel-wide
  outage still surfaces as per-operation failures/refunds exactly as
  before; the lock adds no cross-service coupling.
- **Locks are advisory within this codebase**: a manual panel-side edit
  concurrent with an operation is indistinguishable from legitimate
  drift, exactly as documented for reconciliation.
- **Multi-instance bots** are still not supported by long polling, but
  every lock guarantee here holds across processes/containers - the lock
  is distributed precisely so nothing regresses when a worker process
  starts sharing these pipelines.
