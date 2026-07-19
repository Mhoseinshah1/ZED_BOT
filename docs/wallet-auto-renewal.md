# Wallet Auto-Renewal (Phase 1)

Consent-based automatic renewal of an existing VPN Service, funded from the
user's internal wallet balance. A user opts **one eligible Service** into
auto-renewal, picks a renewal Product, sets a **maximum wallet charge**, reviews
the terms and confirms. Shortly before the Service expires the system renews
**that same Service in place** from the wallet — never a replacement Service,
never above the approved ceiling, never a negative balance.

> **Scope (Part A).** Wallet funding only
> (`AutoRenewalFundingMethod = WALLET`). No Telegram Stars recurring
> subscriptions (a separate future project), no card/crypto recurring, no
> auto‑top‑up, no overdraft/credit, no auto‑coupon, no extra‑volume/extra‑time
> automation, no new‑service automation. The whole system is **disabled by
> default**.

## Consent is the only door (Part B)

`createMandate` (in `apps/bot/src/services/auto-renewal.service.ts`) is the
**single writer** of a `ServiceAutoRenewalMandate`. There is **no**
admin / migration / seed / notification‑click / default‑product path that ever
creates or enables a mandate. Each mandate records:

- `userId`, `serviceId` (`@unique` → one mandate per Service), `productId`
- `maximumChargeToman` — the user‑approved ceiling, re‑validated to cover the
  live price at consent time (`isValidCeiling`)
- `consentedPriceToman`, `consentVersion`, `consentedAt` — versioned,
  timestamped, auditable consent. A bump of the `wallet_auto_renewal_consent_version`
  setting forces re‑consent on resume.
- `chargeLeadMinutes` — how far before expiry to renew.

The user reaches consent from **My Services → service detail →
«تمدید خودکار 🔁»**: choose plan → set a maximum wallet charge → review the exact
Persian terms → confirm. A user may **pause**, **resume** (re‑checks the consent
version + plan + ceiling against live state) or **cancel** at any time, and can
browse **«تمدیدهای خودکار من 🔁»**. Admins may **pause or cancel** a mandate but
can **never** enable one or raise its authorization (`adminStopMandate` only
transitions toward PAUSED/CANCELLED).

## Architecture — why the work is split across worker and bot

`apps/worker` **cannot import** `apps/bot`, and the atomic wallet settlement plus
the renewal executor already live in the bot and are too coupled to relocate.
So responsibilities split cleanly:

| Concern | Where | Notes |
| --- | --- | --- |
| Discovery / scan / reconcile / cleanup / scheduler / heartbeat | **worker** (`apps/worker/src/auto-renewal/`) | Creates one durable attempt per expiry cycle; enqueues EXECUTE. Never moves money, never calls a panel. |
| Wallet charge + in‑place renewal (EXECUTE) | **bot** (`apps/bot/src/services/auto-renewal.service.ts` + `auto-renewal-consumer.ts`) | Reuses the existing atomic wallet settlement + `executeRenewalOrder` + the fulfillment dispatcher. |

The worker **produces** `EXECUTE_WALLET_AUTO_RENEWAL` jobs onto the
`service-auto-renewal-execute` queue; the bot process runs its **first BullMQ
consumer** to execute them (co‑located with fulfillment). Everything is
DB‑authoritative and idempotent, so a duplicate delivery, a retry or a restart
converges — never a double charge.

### Queues & jobs

- `service-auto-renewal` (worker‑owned): `SCAN`, `RECONCILE`, `CLEANUP`,
  driven by a settings‑driven scheduler that removes every recurring job while
  the master switch is off.
- `service-auto-renewal-execute` (bot‑consumed): `EXECUTE`, one durable job per
  attempt (`jobId = war-exec-<attemptId>`).

## The expiry‑cycle fingerprint (dedup + race safety)

`buildAutoRenewalCycleFingerprint(serviceId, expiresAtEpoch, productId, v)` →
sha256/32‑hex, or `null` when there is no finite expiry (unlimited Services are
never auto‑renewed). The attempt table enforces:

- `idempotencyKey @unique` = `wallet-auto-renew:<mandateId>:<fingerprint>` — the
  wallet settlement idempotency key, so **one deduction per cycle**.
- `@@unique([mandateId, expiryCycleFingerprint])` — **one attempt per cycle**.

When the Service expiry moves (a **manual renewal**, extension, or product
change), the fingerprint changes. The execute engine re‑computes the live
fingerprint before charging: a mismatch **cancels the stale attempt with no
charge** — so a manual renewal and an auto‑renewal can never both apply to the
same cycle (Parts U/V).

## Execute engine flow (`executeAutoRenewalAttempt`)

1. Load attempt; only a `SCHEDULED` attempt is claimable (idempotent otherwise).
2. Not‑due guard: a bounded retry sets a future `nextAttemptAt`; an early
   reconcile re‑arm must not consume an attempt before its interval elapses.
3. Master switch off → leave `SCHEDULED` (dormant), no charge.
4. **CAS claim** `SCHEDULED → CLAIMED` (exactly one winner).
5. Mandate not `ACTIVE` → cancel attempt (no charge).
6. Service invalid/deleted/unlimited → pause `SERVICE_INELIGIBLE`, cancel attempt.
7. **Cycle fingerprint mismatch → cancel attempt** (`cycle-changed`), no charge.
8. Plan/panel invalid → pause `PRODUCT_UNAVAILABLE`/`PANEL_UNAVAILABLE`, fail.
9. Live price > ceiling → pause `PRICE_ABOVE_LIMIT`, fail, no charge.
10. `payAutoRenewalWithWallet` — the **same** atomic settlement as manual
    renewals (charges the **live** price ≤ ceiling; never the stored one):
    - `price-above-limit` → pause `PRICE_ABOVE_LIMIT`.
    - `insufficient-balance` → bounded retry (reschedule within the cycle) or
      pause `INSUFFICIENT_BALANCE`. **No** deduction, **no** negative balance.
    - `settled`/`already-settled` → the Order is `PAID`; proceed.
11. `dispatchPaidOrderFulfillment(source: WALLET)` → the existing
    `executeRenewalOrder`: **in‑place renewal**, existing **refund on definite
    failure**, existing **reconciliation on an uncertain panel outcome** (we
    **never** refund here ourselves — an uncertain order stays `PAID` for the
    startup reconciler to complete or refund on proof).

Every Telegram notice is **best‑effort** (`sendSafe`) — a delivery failure never
rolls back a completed renewal.

## Notifications (Part O)

- Pre‑charge notice (renewing now), success (the standard renewal‑success
  message from the dispatcher), insufficient‑balance (retry / paused),
  price‑above‑limit (paused), plan‑unavailable (paused), requires‑action
  (uncertain outcome under review).

## Settings (Part G) — all bounded/clamped, master switch default **false**

| Key | Default | Meaning |
| --- | --- | --- |
| `wallet_auto_renewal_enabled` | `false` | Master switch. |
| `wallet_auto_renewal_scan_minutes` | 5 | Scan cadence. |
| `wallet_auto_renewal_default_charge_lead_minutes` | 180 | Lead before expiry. |
| `wallet_auto_renewal_precharge_notice_minutes` | 1440 | Pre‑charge notice window. |
| `wallet_auto_renewal_insufficient_retry_intervals_minutes` | `[0,360,1440]` | Bounded retry offsets. |
| `wallet_auto_renewal_grace_hours` | 48 | Post‑expiry grace before abandoning a cycle. |
| `wallet_auto_renewal_max_attempts_per_cycle` | 3 | Retry cap per cycle. |
| `wallet_auto_renewal_attempt_retention_days` | 365 | Terminal‑attempt cleanup window. |
| `wallet_auto_renewal_consent_version` | 1 | Bump to force re‑consent. |

## Admin page

**تنظیمات عمومی ⚙️ → تمدید خودکار 🔁** (OWNER‑only): master‑switch activation gate
(worker must be alive; disabling always allowed), authoritative mandate/attempt
counts, a **read‑only dry‑run preview** of what the next scan would pick up,
paused‑mandate review with admin pause/cancel, and a **manual scan** trigger.

## Safety invariants (the "do not claim completion until" list)

- No mandate without explicit user consent; no admin/seed/migration enable.
- No charge above the ceiling; no charge on a stale Service state; no negative
  wallet; no double deduction (idempotent on the mandate+cycle key).
- A manual renewal and an auto‑renewal can never both apply to one cycle.
- The existing Service is renewed **in place** — never a replacement Service.
- Definite fulfilment failures refund via the existing path; uncertain outcomes
  are reconciled before any refund.
- Cancellation prevents every future charge; the system is disabled by default.

See also: `docs/wallet-auto-renewal-operations.md`.

## Durable pre-charge notices (Corrective Phase)

Wallet auto-renewal now sends a **durable advance notice** (`AUTO_RENEWAL_UPCOMING`,
category PAYMENT) normally ~24h before the wallet deduction, instead of the old
best-effort "renewing now" message sent at charge time (which was removed). The
notice is scheduled by the worker scan, deduped per expiry cycle, revalidated
against live price/cycle at delivery, and offers a real cancellation window. A
charge is gated on the notice (never charged before it is delivered/terminal, never
frozen by a Telegram outage). Configured by
`wallet_auto_renewal_precharge_notice_minutes` (default 1440; `0` disables only the
advance notice). Full detail: [wallet-auto-renewal-precharge-notices.md](./wallet-auto-renewal-precharge-notices.md).
