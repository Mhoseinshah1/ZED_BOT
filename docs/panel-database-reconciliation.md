# Panel/Database Reconciliation in Crash Recovery

Fixes the unsafe recovery rule introduced with the startup crash-recovery
sweep: an order stuck in `PROVISIONING` with no database completion anchor
was marked `FAILED` and refunded. That rule was wrong in exactly the crash
window the sweep exists for.

## The unsafe scenario

```
pipeline claims order            (PAID -> PROVISIONING, committed)
panel mutation succeeds          (account created / renewed / extended)
process crashes                  (DB persistence transaction lost)
--- restart ---
recovery sees: PROVISIONING, no Service row, no ServiceEventLog row
OLD BEHAVIOR: mark FAILED + refund wallet
```

A missing database anchor does **not** prove the remote panel mutation did
not happen — the persistence commit is the *last* step, so "panel done, DB
lost" is a real (and the most valuable) crash window. The old rule handed
such users both the panel mutation **and** their money back, and for
purchases it also stranded a live panel account with no Service row.

## The reconciliation rule

Recovery may refund **only on positive proof** that the panel mutation did
not happen, and may complete **only on positive proof** that it did.
Anything unprovable is **deferred** — the order stays `PROVISIONING`, is
retried on every sweep (startup + the 15-minute re-check), and is loudly
logged for manual resolution. Uncertainty never moves money.

### Purchases (`SERVICE_PURCHASE`)

The panel username is deterministic per order
(`generatePanelUsername(telegramId, orderId)`), so the account can always
be probed with the read-only `getServiceAccount`:

| Panel answer | Meaning | Action |
|---|---|---|
| account exists | create succeeded, DB commit lost | **Adopt**: recreate the Service row (sold values from the order's immutable snapshots, connection data from the panel's own report), complete the order. No refund. |
| positively absent (`notFound`) | create never happened | `failOrderWithRefund` — same as an in-process failure. |
| cannot check | unreachable / auth failure / adapter without read support | **Defer.** |

`notFound` is a new structured field on `GetServiceAccountResult`, set
**only** when the panel positively reports the account does not exist
(Marzban: documented 404 on `GET /api/user/{username}`; XUI: a fully
readable and parseable inbound inventory with no matching client).
Transport errors, auth failures and unreadable inbounds never set it —
"could not check" is not "does not exist".

### Renewals / extra volume / extra time

The target account exists either way (these mutate an existing account), so
existence proves nothing. Instead the mutation-owned fields are compared
against the Service row's stored **pre-mutation** state — the crash lost the
DB update, so the row still holds the old values:

| Order type | Compared field(s) |
|---|---|
| `EXTRA_VOLUME` | data limit |
| `EXTRA_TIME` | expiry |
| `SERVICE_RENEWAL` | data limit **or** expiry changed ⇒ applied; both comparable and unchanged ⇒ not applied |

- **Panel differs** → the mutation applied: recovery persists the
  pipeline's own anchor (`ServiceEventLog` with `metadata.orderId` and
  `reconciled: true`) and updates the Service row from the panel's reported
  truth, in one transaction with the order completion. Re-runs then
  short-circuit as anchored. No refund.
- **Panel identical** → the mutation never applied: refund (safe — the
  user's panel state is untouched).
- **Account absent** → the panel `PUT` would have 404-failed in-process:
  refund.
- **Field not reported / adapter cannot read** → defer.

Only fields the bot itself mutates are compared. Usage (`used_traffic`)
grows on its own and never decides. Expiry comparison tolerates 1.5s
(Marzban stores unix seconds; stored values are millisecond dates).

## Serialization and exact attribution (service-operation concurrency phase)

Reconciliation now additionally runs under the SAME distributed
per-service lock as every live mutation (see
docs/service-operation-concurrency.md):

- `reconcileServiceMutation` acquires `zedbot:service-operation:<serviceId>`
  and `reconcilePurchase` acquires
  `zedbot:service-provisioning:<panelId>:<username>` with a zero wait -
  contention means live work, so the stale order defers immediately. One
  Order can therefore never observe (and claim) a remote change another
  concurrent operation is making mid-flight.
- Under the lock, the order status and completion anchors are re-checked
  before the panel is queried.
- The comparison itself was upgraded from "any owned field changed" to
  EXACT expected-state attribution (`classifyMutationState`): APPLIED only
  when the panel matches the order's exact recomputed post-state
  (pipeline-owned calculation from the stored pre-state + the order's
  immutable plan snapshot), NOT_APPLIED only on an exact pre-state match,
  and everything else - including values explainable only by another
  operation - is UNKNOWN and defers.
- With Redis unavailable the whole sweep defers (fail closed); nothing is
  completed or refunded without the lock.

## Why this cannot double-settle

- Every completion is a CAS on `PROVISIONING`; the refund path is the
  existing idempotent `failOrderWithRefund` (CAS flip + existing-refund
  short-circuit). Two sweeps racing the same order settle it exactly once
  (covered by test).
- Reconciled completions write the pipeline's own anchor, so any later
  sweep resolves via the anchor path without touching the panel again.
- Adoption re-checks for an existing Service row inside its transaction and
  the panel username is unique — one order can never gain two services.

## Deliberate edge cases and limitations

- **Deferred orders park indefinitely** until the panel becomes readable or
  an admin intervenes; each sweep logs a warning with the order id and
  reason. This is intentional: money only moves on proof. XUI purchases
  AND mutation orders (renewal/extras) now reconcile like Marzban ones:
  the SANAEI adapter reads clients (positive absence semantics) including
  quota and expiry, so `classifyMutationState` attributes XUI orders
  exactly. XUI expiry is stored in unix milliseconds verbatim, so the
  1.5s tolerance (needed for Marzban's whole seconds) is trivially
  satisfied.
- **Renewal coincidence**: a renewal plan with `durationDays = 0` whose
  computed new limit happens to equal the old limit is indistinguishable
  from "not applied" and refunds. The error direction favors the user
  (panel state kept + refund) and requires an exact byte-for-byte
  coincidence.
- **Panel edited by a human between crash and sweep**: a manual panel-side
  change is indistinguishable from the bot's mutation and resolves as
  "applied" (complete, no refund) — refunding here would be equally wrong,
  and completion matches what the paying user observes on the panel.
- **Adopted purchases take the panel's reported expiry**, which reflects
  the original attempt time, so the user loses nothing to the crash gap.
- Recovery still sends no Telegram messages; refunds surface in wallet
  history (see docs/background-jobs-audit.md).
