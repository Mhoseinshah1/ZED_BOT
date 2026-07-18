# Service Notification Rules & Deduplication (Phase 1)

How the scan (`apps/worker/src/notifications/{scan,rules}.ts`) turns fresh
`Service` state into `AutomatedNotification` rows, and how deduplication keeps a
user from being alerted twice for the same event while still re-alerting after a
genuine new cycle.

## Thresholds (operator-configurable)

| Rule | Setting | Default buckets |
|------|---------|-----------------|
| Service expiry | `notification_expiry_thresholds` | `7d, 3d, 1d, 12h, 3h, expired` |
| Traffic | `notification_traffic_thresholds` | `80%, 90%, 100%` |
| Trial | `notification_trial_thresholds` | `30m, 10m, expired` |

Values are parsed + validated by `parseExpiryThresholds` /
`parseTrafficThresholds` in `@zedbot/shared`; an invalid stored value falls back
to the defaults (never throws, never silently drops all thresholds).

## Bucket selection (one notice per rule per scan)

The scan never back-fills earlier buckets. It picks the **single** currently
applicable bucket:

- **Expiry / trial** (`pickExpiryBucket`): the threshold with the *smallest*
  `minutesBefore` that is still ≥ the minutes remaining (the tightest window
  already entered). `minutesToExpiry ≤ 0` selects the `expired` bucket. A
  service more than `7d` from expiry (or a never-expiring service) yields none.
  - Paid → `SERVICE_EXPIRY` / `SERVICE_EXPIRED`; trial → `TRIAL_NEAR_EXPIRY` /
    `TRIAL_EXPIRED`.
- **Traffic** (`pickTrafficBucket`): the *largest* threshold ≤ the raw usage
  percentage. Under the lowest threshold → none. Unlimited services
  (`volumeBytes ≤ 0`) never qualify. Type `SERVICE_TRAFFIC`.
- **Status**: `status == LIMITED` → `SERVICE_LIMITED`.

Percentages are computed with **BigInt-only** math (`computeTrafficUsage`) — the
byte values are never coerced to a float before dividing, so a multi-TB quota is
exact. Display is clamped to 100; the raw (uncapped) percentage is kept in the
snapshot meta for diagnostics.

## Who is scanned

Candidate services: `status ∈ {ACTIVE, LIMITED, EXPIRED}`, not deleted. A trial
is a service with `source = FREE_TRIAL` and `convertedToPaidAt = null`; once it
converts it is treated as paid (expiry/traffic rules) and trial notices stop.

The scan skips a service entirely when the user's SERVICE gate is shut
(inactive user, `cronNotificationsEnabled` off, or `serviceNotificationsEnabled`
off), and skips a single rule when the per-service override disables it.

## Freshness gate

Traffic and status derive from panel sync, so the scan only evaluates them when
the service state is **fresh** (`lastSubscriptionUpdateAt` within
`notification_service_state_max_age_minutes`, default 20). A stale service is
left for the next sync + scan cycle — a notification is **never generated from
stale traffic/usage state**. Expiry/trial use the DB-authoritative `expiresAt`
(updated immediately on renewal), so they do not need panel freshness.

## Deduplication

Every row has a unique `dedupeKey`. The scan attempts a `create`; a `P2002`
unique violation means "already created this cycle — do nothing". This also
makes **concurrent scans** safe: two scans racing on the same service create
exactly one row.

### Expiry cycle

```
expiryDedupeKey(serviceId, thresholdKey, expiresAt, trial)
  = service:<id>:<expiry|trial>:<thresholdKey>:<hash(expiresAt)>
```

The cycle fingerprint is `hash(expiresAt)`. A **renewal** (or extra-time) moves
`expiresAt` → a new fingerprint → the same threshold can re-alert in the new
cycle. Within one cycle a repeated scan is deduped.

### Quota cycle

```
trafficDedupeKey(serviceId, percent, volumeBytes, expiresAt)
  = service:<id>:traffic:<percent>:<hash(volumeBytes|expiresAt)>
```

The quota fingerprint is `hash(volumeBytes + expiresAt)`. A **renewal**
(`expiresAt` changes) or an **extra-volume purchase** (`volumeBytes` changes)
opens a new quota cycle → re-alert allowed. A pure usage reset *without* a
renewal (a rare admin-only action) does not re-open the cycle — documented and
intentional.

## Availability window

`availableUntil` bounds how long a scheduled notice stays relevant:

- pre-expiry / traffic: until `expiresAt` (a new cycle re-alerts anyway);
- expired: `now + 3 days` (paid) / `now + 1 day` (trial);
- limited: `now + 3 days`.

Past `availableUntil`, delivery marks the row `EXPIRED` instead of sending.

## Capability-aware buttons

`buildNotificationButtons` emits only actions the service currently supports —
`open` always; `renew` only for renewable paid services on an active,
renewal-enabled panel; `buy extra volume` only for a metered, active service;
`dismiss` always. Trials get open + dismiss only. The bot re-validates capability
on click (`resolveServiceDetailActions`), so a button never performs an action
the user is not entitled to, and there are **no dead buttons**.
