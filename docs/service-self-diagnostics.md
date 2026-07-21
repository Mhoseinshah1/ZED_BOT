# Service self-diagnostics

`بررسی مشکل سرویس 🛠` — a user-facing, read-only self-diagnostics capability for a
single Service. It reports what ZED_BOT can **authoritatively** know from the
server side, explains the likely problem in simple Persian, and routes the user
to the correct **existing** action. It never repairs anything automatically.

Feature branch: `feat/service-self-diagnostics`. The whole system is **dormant by
default** (`service_diagnostics_enabled = false`) and must be enabled by the OWNER.

---

## Trust / evidence model

Diagnostics only reasons about server-side, stored or once-read facts:

- the current **Service** database row (status, quota, expiry, connection
  timestamps, subscription/config payload availability);
- the associated **Panel** configuration/status and adapter capability;
- **one** bounded, authenticated panel account read (`getServiceAccount`);
- the current supported lifecycle actions (`resolveServiceDetailActions`).

Evidence priority (highest first):

1. **`LIVE_PANEL`** — a successful current panel account read.
2. **`FRESH_CACHE`** — a Service row synchronized within the display TTL
   (`SERVICE_SYNC_TTL_SECONDS`, default 60s) when a live read was not obtained.
3. **`STORED_ONLY`** — the last saved Service information, shown with a visible
   stale-data warning.

### What the Bot can and cannot test

The Bot **can** observe: service status, quota (used/total/remaining), expiry,
payload presence, first/last connection timestamps the panel reports, and whether
the panel is reachable and the account exists.

The Bot **cannot** test, and never pretends to: the customer's phone, device
network settings, ISP filtering, DNS on the device, application configuration,
local VPN permissions, whether a QR was scanned correctly, or actual packet
reachability from the customer's device. The report ends with a fixed limitations
line (`service_diagnostics_limitations`) stating this.

The three evidence classes are always distinguished in the report: server-side
evidence (the checks), stored information (the freshness line), and conditions the
Bot cannot check (marked `UNKNOWN`, and the limitations line).

---

## Diagnostic states and precedence

Each run produces up to eight checks (`SERVICE_STATE`, `PANEL_STATE`,
`PANEL_ACCOUNT`, `QUOTA`, `EXPIRY`, `CONNECTION_PAYLOAD`, `CONNECTION_HISTORY`,
`DATA_FRESHNESS`), each with a stable machine `code` and a status
(`PASS`/`INFO`/`WARNING`/`FAIL`/`UNKNOWN`). Behaviour is driven by codes/enums —
**never** by comparing Persian strings.

Each check contributes an overall candidate; the report's single primary result
is the **most severe** candidate (a later `PASS` can never overwrite a more
serious condition). Precedence, most severe first:

| # | Condition | Overall |
|---|-----------|---------|
| 1 | positive remote account absence / `FAILED` service / missing panel | `NEEDS_SUPPORT` |
| 2 | panel authentication failure | `NEEDS_SUPPORT` |
| 3 | panel unreachable or timeout / panel inactive | `UNAVAILABLE` |
| 4 | `EXPIRED` / `LIMITED` / `DISABLED` / missing connection payload / quota exhausted | `ACTION_REQUIRED` |
| 5 | stale/stored evidence / never-connected (`CREATING`, `HISTORY_NONE`) | `DEGRADED` |
| 6 | all authoritative checks pass | `HEALTHY` |

Severity ranking: `NEEDS_SUPPORT > UNAVAILABLE > ACTION_REQUIRED > DEGRADED >
HEALTHY` (`OVERALL_SEVERITY` / `worstOverall` in `@zedbot/shared`).

### Authoritative evidence rules

- `notFound === true` is **positive** absence → `NEEDS_SUPPORT` (the account is
  not in the panel). Link regeneration is never presented as a guaranteed fix; no
  automatic recreate/refund/delete/migrate.
- timeout / auth / unreachable is **not** proof the account is absent
  (`ACCOUNT_UNVERIFIED`).
- an unsupported adapter operation (`readService` capability absent) is **not**
  account absence → the report uses `STORED_ONLY` and states live verification is
  unavailable.
- missing panel fields stay **`UNKNOWN`**, never coerced to zero. `null`
  unlimited quota/expiry semantics are preserved (`QUOTA_UNLIMITED` /
  `EXPIRY_NONE`, never "0 remaining" / "expired").
- a panel failure never overwrites the Service row; raw panel responses never
  enter the report.
- a missing connection timestamp is not proof the customer never connected when
  the panel does not report history → `HISTORY_UNKNOWN` (non-escalating); only a
  live read that actually reports history fields yields `HISTORY_NONE`.

---

## One-panel-read architecture

A diagnosis performs **at most one** authenticated panel account read. The shared
read primitive lives in `apps/bot/src/services/service-sync.service.ts`:

```
readServiceAccountAndSyncUnlocked(serviceId, userId)  // the single read + sync core
  ├─ syncServiceFromPanel(...)      → projects to the unchanged SyncServiceResult
  └─ readServiceForDiagnostics(...) → same lock, returns the rich PanelReadOutcome
```

`readServiceForDiagnostics` takes the **same per-Service distributed lock** as
sync (`serviceOperationLockKey`), runs the one read, updates the row **only on a
successful read**, and returns a classified `PanelReadOutcome` the diagnostics
service consumes directly — there is no `diagnose → sync → fetch again`.

An explicit diagnosis requests fresh evidence (it bypasses the display TTL) but is
cut off at a bounded budget (`SERVICE_DIAGNOSTICS_READ_TIMEOUT_MS`, default 8s,
clamped to [1s, 30s]). On timeout the report is returned with the freshest cache /
stored evidence and the underlying read continues safely in the background (it
never rejects) and persists for next time. Lock contention returns a **retryable**
report (`PANEL_BUSY` / `DEGRADED`), never an exception.

---

## Cooldown and the Service lock

- **Cooldown** (`service_diagnostics_cooldown_seconds`, default 30, range 5..600):
  a best-effort per **owner + Service** window (`checkAndArmCooldown` in
  `service-lock.service.ts`, reusing the lock's Redis client — no second client).
  A retry inside the window shows the remaining seconds; there is no permanent
  lockout. **Redis unavailability fails open** (a cooldown outage never blocks or
  crashes the bot).
- **Service lock**: the per-Service distributed lock remains the authoritative
  concurrency guard for the panel read (fails **closed**). Repeated clicks cannot
  create an unbounded number of background calls — the cooldown throttles new runs
  and the lock serialises concurrent reads.

---

## Action mapping

Recommendations are typed (`ServiceDiagnosticAction`) and generated **only** from
the current report, actual payload availability, `resolveServiceDetailActions`,
the master switches and the guide gate — no unavailable action is ever rendered.
Every action reuses an **existing** callback; nothing here mutates anything.

| Action | Reused callback | Rendered when |
|--------|-----------------|---------------|
| `RETRY_DIAGNOSTIC` | `user:svc:diag:<sid>:retry` | always |
| `REFRESH_SERVICE` | `user:svc:refresh:<sid>` | `CREATING` |
| `OPEN_CONNECTION_GUIDE` | `user:svc:guide:<sid>` | guide entry available |
| `SHOW_SUBSCRIPTION_LINK` / `SHOW_SUBSCRIPTION_QR` | `user:svc:link` / `qr_sub` | subscription URL stored |
| `SHOW_CONFIGS` / `SHOW_CONFIG_QRS` | `user:svc:configs` / `qr_configs` | ≥1 config stored |
| `ENABLE_SERVICE` | `user:svc:enable:<sid>` | `toggleAction === ENABLE` |
| `RENEW_SERVICE` | `rn:<sid>` (renewal) | `canRenew` |
| `BUY_EXTRA_VOLUME` | `ev:<sid>` (extra volume) | `canBuyExtraVolume` |
| `REGENERATE_LINK` | `user:svc:regen_link:<sid>` | `canRegenerateLink` |
| `OPEN_SUPPORT` | `user:svc:diag:<sid>:support` | always |

Ordering: the action most likely to resolve the diagnosed condition first, then
guide/link/QR, then retry, then support, then back navigation. When no eligible
resolving action exists for an `ACTION_REQUIRED` condition, support leads (a
connection method that cannot help is never presented as the fix).

---

## Support handoff with a safe snapshot

The user must explicitly choose `ارسال گزارش به پشتیبانی 🎫`. The flow:

1. show the safe report preview (`user:svc:diag:<sid>:support`);
2. confirm to attach (`user:svc:diag:<sid>:sup_yes`);
3. enter the **existing** support message flow (`support:message`);
4. the user writes their explanation;
5. one normal ticket is created by the existing engine (`createSupportTicket`);
6. the validated safe snapshot is linked to the ticket;
7. admin ticket detail shows the linked-service jump, the safe diagnostic summary
   and the user message.

Ownership is re-resolved (`getOwnedServiceById`) and the snapshot re-validated
(`validateDiagnosticSnapshot`) **before** attaching — a stale/foreign handoff can
never create a ticket for another Service/user (the attachment is silently
dropped and a normal ticket is still created). Cancel/back clears all
diagnostic-support session state (`clearDiagnosticHandoff`, the handoff-cancel
middleware, and `clearSupportState`).

### Support snapshot schema (strict, version 1)

```jsonc
{
  "version": 1,
  "overall": "ACTION_REQUIRED",
  "evidenceSource": "LIVE_PANEL",
  "checkedAt": "2026-07-21T12:00:00.000Z",
  "checks": [ { "key": "QUOTA", "status": "FAIL", "code": "QUOTA_EXHAUSTED" } ],
  "primaryRecommendation": "RENEW_SERVICE"
}
```

`buildDiagnosticSnapshot` / `validateDiagnosticSnapshot` (`@zedbot/shared`) copy
**only** these fields; unknown fields are dropped and any deviation (bad enum,
over-length code, too many checks, wrong version, non-object) fails closed. The
snapshot **never** carries a subscription URL, config, token, panel credential,
remote client id, raw panel message or any free-form text. It is persisted **only
after** explicit support handoff — there is no per-run diagnostic history row.

---

## Privacy guarantees

Allowed aggregate SystemLog events: `diagnostics.completed`,
`diagnostics.cooldown_hit`, `diagnostics.live_read_unavailable`,
`diagnostics.support_handoff_started`, `diagnostics.snapshot_attached`. Their
metadata carries only: overall code, evidence source, check status counts, panel
type, sanitized diagnostic code, duration, and a **non-reversible correlation
hash** (`sha256(userId:serviceId)` truncated).

Never logged: User ID, Telegram ID, full Service ID, service username,
subscription URL, config link, token, panel base URL, panel credentials, raw
response, remote client id, ticket message, or a snapshot with free-form content.

---

## No automatic repair

This feature is **diagnosis and guided recovery only**. It never automatically
recreates/deletes a panel account, resets traffic, changes expiry,
enables/disables, regenerates a subscription, migrates panels, refunds an order,
changes wallet balance, modifies a product or retries fulfillment. Every mutation
stays behind its existing explicit user confirmation and business rules.

---

## OWNER settings (`عیب‌یابی سرویس 🛠`)

Under General Settings, OWNER-only (`admin:diag:root`, the handler re-checks
`ctx.admin.role === "OWNER"` on every callback). Shows: the master switch, the
cooldown, the recent-connection threshold, the number of active panels that do /
do not support a live `readService`, the safe limitations copy, a bounded recent
event summary, and a read-only **preview** by service short id.

- Master switch: atomic compare-and-set (stale-state safe). Enabling moves no
  money and changes no Service; disabling deletes no data.
- Cooldown / recent-connection: preset buttons + per-setting reset to default.
- Preview: an admin-authorized (any owner) read-only diagnosis of an entered
  service short id. It runs the one bounded panel read with **`persist: false`**,
  so the customer's Service row is never written; it clearly says it is a
  preview, creates **no** ticket, and moves no money / mutates no panel.

Settings keys (typed contract in `packages/shared/src/service-diagnostics.ts`):
`service_diagnostics_enabled`, `service_diagnostics_cooldown_seconds`,
`service_diagnostics_recent_connection_hours`. The panel-read timeout is the
bounded env `SERVICE_DIAGNOSTICS_READ_TIMEOUT_MS`.

---

## Operational failure behaviour (fail-soft)

- a diagnostic failure never alters Service status;
- a Telegram failure never alters a Service/Order;
- a panel timeout never refunds or mutates;
- Redis/cooldown failure never crashes the bot (fails open);
- a SystemLog failure never breaks the report;
- a support-notification failure never rolls back ticket creation;
- a successful panel read uses the existing safe Service-row sync semantics.

No existing Service lock or panel capability gate is weakened.

---

## Limitations

- Diagnostics can only reason about server-side, stored or once-read evidence —
  it cannot see the customer's device, network, ISP, DNS or app.
- Connection-history reasoning depends on what the panel reports; when it reports
  no history the result is `UNKNOWN`, not "never connected".
- The preview and every user run perform a real panel read subject to the panel's
  own timeout; a slow panel yields a bounded stored/cache report.
