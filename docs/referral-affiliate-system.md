# Referral & Affiliate System — Phase 1

Branch: `feat/referral-affiliate-system` · Status: **disabled by default**

Phase 1 turns the existing referral **attribution** scaffolding (linking a new
user to whoever invited them) into a working **affiliate program**: when a
referred user completes a paid order, the person who referred them earns a
configured percentage of that order as a **wallet commission**. The whole payout
is gated behind a master switch that is **off on every install** until the bot
OWNER turns it on. This document is the authoritative contract.

> Scope note: the broader conversation referenced a "Phase 1 specification" that
> was not present in this repository or conversation. The scope below was defined
> from the codebase's own conventions (the existing `Referral` /
> `ReferralCommission` models, the wallet-ledger pattern, the after-commit
> fulfillment hook, and the OWNER-gated admin settings pages). Every design
> decision is documented here so the boundaries of "Phase 1" are explicit.

## 1. What Phase 1 delivers

- **Referral deep links** — every user has a personal invite link
  `https://t.me/<bot>?start=<code>` shown on a dedicated «زیرمجموعه‌گیری» page,
  with a one-tap Telegram share button and their live earnings.
- **Wallet affiliate commissions** — a referred user's *completed* order credits
  the referrer's internal wallet with `floor(orderAmount × percent / 100)` Toman,
  written as a real `WalletTransaction` (type `COMMISSION`, source `REFERRAL`).
- **OWNER admin page** — a «زیرمجموعه‌گیری و پاداش» settings page to enable/disable
  the payout, set the commission percent, toggle first-purchase-only, set a
  minimum qualifying order, and read the paid/reversed totals.

Attribution (the `/start` linker, `applyReferralIfEligible`) already existed and
is **unchanged in behaviour** — it always runs, independent of the payout switch.

### Explicitly NOT in Phase 1

- No referral gift/bonus to the *referred* user (only the referrer earns).
- No withdrawal/cash-out of wallet commission — it is ordinary wallet balance,
  spendable through the existing wallet, nothing new here.
- No multi-level / tiered commissions — one hop only (direct referrer).
- No retroactive back-fill — a commission is only ever created going forward,
  for orders that complete while the system is enabled.

## 2. The master switch (payout is off by default)

| Setting key | Default | Meaning |
|-------------|---------|---------|
| `referral_system_enabled` | `false` | Gates the **payout only**. Attribution linking is unaffected. |
| `referral_commission_percent` | `10` | Whole-number percent of the qualifying order. Clamped 0–100. |
| `referral_first_purchase_only` | `true` | When true, only the referred user's **first** commissioned order pays. |
| `referral_min_purchase_toman` | `0` | Orders paid below this never earn a commission. Clamped 0–1,000,000,000. |

All four are read through the bot settings service (30 s TTL cache) and every
stored value is validated + clamped; an invalid/missing value falls back to the
code default (`DEFAULT_REFERRAL_CONFIG` in `packages/shared/src/referral.ts`).
The menu button is gated on `referral_system_enabled`, so with the payout off the
«زیرمجموعه‌گیری» button is hidden and the default menu is unchanged.

## 3. The money engine (`referral-commission.service.ts`)

`creditReferralCommissionForOrder(orderId)` is the single credit path. It is
called by the after-commit fulfillment hook and returns a structured outcome; it
**never throws** for a business reason (callers wrap it fail-soft so a commission
problem can never break a paid order).

Preconditions checked, in order:

1. `referral_system_enabled` is true — else `disabled`.
2. The order exists and is `COMPLETED` with a `completedAt` — else
   `order-missing` / `not-completed`.
3. The buyer has a `Referral` row (was attributed) — else `no-referrer`.
4. The referrer is not the buyer — else `self-referral`.
5. If `first_purchase_only`, no prior `PENDING`/`PAID` commission exists for this
   referral — else `not-eligible`. (A prior *below-minimum* order created no
   commission row, so it never consumes the first-purchase slot.)
6. The pure calculator (`resolveReferralCommission`) returns an eligible,
   positive, floored amount — else `not-eligible`.

### Idempotency + atomicity

The credit runs in one `prisma.$transaction`:

1. **Claim first** — `ReferralCommission` is `create()`d with the order's
   **`@@unique(orderId)`**. A re-fired hook or a concurrent settlement collides
   here (`P2002`) *before any money moves* and returns `already-credited`.
2. **Credit the wallet** — `user.update({ balanceToman: { increment } })` locks
   the row and returns the true post-balance; `balanceBefore = balanceAfter −
   amount`. The balance is **never pre-read** (that would race a concurrent
   spend).
3. **Write the ledger** — one `WalletTransaction` (`COMMISSION` / `REFERRAL`)
   with the truthful `balanceBeforeToman` / `balanceAfterToman`.
4. Aggregates on `User` and `Referral` are incremented, and the referral's
   `firstPurchaseAt` / `firstPurchaseOrderId` are stamped on the first credit.

One order → at most one commission, enforced by the DB, proven by the concurrency
test.

## 4. Reversal (clawback on refund)

`reverseReferralCommissionForOrder(orderId)` claws a paid commission back when its
source order is refunded/cancelled. It is wired into `failOrderWithRefund`
(`provisioning.service.ts`) and fires only when a refund actually happened.

- CAS on `status = PAID → REVERSED` — only the one caller that flips the status
  performs the clawback, so repeated refund signals reverse exactly once.
- A compensating `SYSTEM_ADJUSTMENT` / `REFERRAL` debit reverses the wallet
  credit and the `User` / `Referral` aggregates; `reversedAt` and
  `reversalWalletTransactionId` are stamped.
- Only a `PAID` commission is reversed; `PENDING` / `CANCELLED` / `REVERSED` are
  left as-is (`not-paid` / `already-reversed` / `no-commission`).
- A clawback may push the referrer's wallet negative (they owe the credit back) —
  intended ledger behaviour, mirroring the rest of the wallet.

## 5. Data model

Additive only (`packages/database/prisma/schema.prisma`, migration
`20260719180000_referral_affiliate_commissions`):

- `ReferralCommissionStatus` gains `REVERSED`.
- `ReferralCommission` gains `reversalWalletTransactionId` + `reversedAt`, and its
  `@@index([orderId])` becomes **`@@unique([orderId])`** — the idempotency
  keystone.

The pre-existing `Referral`, `ReferralCommission`, `User.referral*` fields,
`WalletTransactionType.COMMISSION` and `WalletTransactionSource.REFERRAL` are
reused as-is.

## 6. UI surfaces

- **User** — `handlers/user-referral/referral.handler.ts` renders the referral
  page (deep link, share button, live referred-count + paid-commission total).
  Reachable from the inline menu and, in reply-keyboard mode, by the
  «زیرمجموعه گیری 👥» label — both routed through the same `renderReferralPage`.
- **Admin (OWNER-only)** — `handlers/admin-settings/referral-admin.handler.ts`
  (`admin:referral:*` callbacks), linked from the general settings landing.

## 7. Tests

- `apps/bot/tests/referral-rules.test.ts` — the pure calculator (flooring, never
  over-crediting, below-minimum, zero/invalid, clamp, deep-link).
- `apps/bot/tests/referral-commission.test.ts` — DB-backed engine: credit
  correctness + truthful ledger row, idempotency, concurrency (one commission per
  order), first-purchase-only, all-purchases mode, minimum, zero-percent,
  disabled switch, eligibility guards, reversal + idempotent reversal + concurrent
  reversal, and the `/start` attribution linker. Skips itself unless
  `DATABASE_URL` points at a migrated, disposable database.
- `apps/bot/tests/referral-financial-safety.test.ts` — the hardening matrix (see
  §8): first-purchase concurrency across two orders, activation horizon, durable
  credit/reversal/recovery scans, no-overdraft reversal + debt recovery, atomic
  attribution races, the disabled-route gate, and PII-safe status.
- `apps/bot/tests/referral-migration-guard.test.ts` — the unique-orderId preflight
  across clean / legacy / nullable / duplicate database states.

## 8. Financial-safety hardening

A later pass hardened every money path. All changes are additive and the program
stays **disabled by default**.

### 8.1 Concurrency authority (first-purchase-only)

The credit locks the **Referral row** (`SELECT … FOR UPDATE`) and re-checks the
first-purchase-only policy *inside* that lock, so two DIFFERENT qualifying orders
for one referral can never both observe zero prior commissions — exactly one pays.
Same-order concurrency is still resolved by the unique `orderId`. Outcomes are
typed results (no `Error`-string control flow).

### 8.2 Activation horizon (no historical back-fill)

Enabling payouts stamps `referral_commissions_started_at` **exactly once**
(preserved across disable/re-enable). Only orders completed **at/after** that
instant are eligible; a **null** horizon is fail-closed (nothing is credited).
Historical orders can never suddenly earn a commission.

### 8.3 Durable reconciliation (worker + bot execute)

The live after-commit hook now **enqueues** a retryable job instead of crediting
inline, so a crash / transient DB error can't lose a commission. A worker engine
(`apps/worker/src/referral/`) owns four bounded, safe-on-any-cadence scans on the
`referral-commissions` control queue and produces execute jobs onto
`referral-commissions-execute`, which the **bot** consumes (the wallet mutation is
co-located with the ledger; the worker cannot import the bot):

| Scan | Finds | Enqueues |
|------|-------|----------|
| credit | COMPLETED, post-horizon, referred, no commission | `CREDIT` |
| reversal | PAID commissions whose order has **authoritative** refund evidence (a REFUND `WalletTransaction` or a terminal Order status) | `REVERSE` |
| recovery | `REVERSAL_PENDING` debts (funds may have arrived) | `RECOVER` |
| cleanup | terminal rows past retention (the ledger persists) | — |

A Redis flush or a missed enqueue is recovered by the DB scan; a process restart
re-runs the scans; every execute job is idempotent, so nothing double-credits.
The credit/reversal scans self-gate on the master switch; recovery/cleanup run
regardless so an owed debt stays collectable after payouts are paused. The OWNER
admin page adds a manual **reconcile now** action and reads a PII-free worker
status snapshot (counts + timestamps only). Reversals never act on an uncertain
remote/panel state — only real refund records count.

### 8.4 No-overdraft reversal + auditable debt

A clawback never drives a normal wallet negative (`allowNegativeBalance=false`):
it recovers only what the balance affords, writes a truthful `SYSTEM_ADJUSTMENT` /
`REFERRAL` debit for the actual amount, and moves any shortfall into a
`REVERSAL_PENDING` debt tracked on the commission (`recoveredToman`,
`recoveryOutstandingToman`, a CHECK bounding `0 ≤ recovered ≤ amount`). The
recovery scan collects the remainder as funds arrive; the row lock serialises
concurrent reversals/recoveries so a debt is **collected exactly once, never
over-collected**, and the ledger stays gapless. `allowNegativeBalance=true` users
are fully clawed back as before. See `wallet-ledger-integrity.md` for the debit
semantics and reconstruction rule.

### 8.5 Atomic attribution

`applyReferralIfEligible` now runs one transaction: a **conditional claim**
(`updateMany … where referrerId IS NULL`, evaluated against the live row, not a
stale object) plus the `Referral` row together. Concurrent `/start` with different
codes converge on exactly one referrer; an existing attribution is never replaced;
the relation and the row always reference the same referrer.

### 8.6 Counter semantics (gross vs net)

To remove ambiguity, the counters have **explicit, documented** meanings:

| Counter | Semantics |
|---------|-----------|
| `User.totalReferralPurchaseCount` | **GROSS** — referred purchases that earned a commission; never decremented (a historical sale) |
| `User.totalReferralPurchaseAmountToman` | **GROSS** — same, in Toman |
| `Referral.totalPurchaseAmountToman` | **GROSS** — per-referral purchase volume |
| `User.totalReferralCommissionToman` | **NET** — commission actually retained (credited − recovered); decremented by each clawback |
| `Referral.totalCommissionAmountToman` | **NET** — same, per referral |

The admin overview reports **paid** (count + Toman), **fully reversed** (count +
Toman), **reversal-pending** (count + outstanding Toman) and **net retained** =
paid + pending-outstanding, separately. Gross commission is never called "profit".

### 8.7 Migration safety

The `20260720121000_referral_commission_orderid_unique_guard` migration detects
duplicate non-null `orderId` values and **fails with an actionable message**
before (idempotently) re-asserting the unique index — safe on clean, legacy,
nullable and duplicate databases (tested).

## 9. Review-blocker hardening (PR #109 follow-up)

A second review pass raised eight blockers; all are resolved here.

### 9.1 Payout ACTIVE-WINDOWS replace the single-instant horizon

Eligibility is no longer "completed at/after one horizon instant" (which paid
orders completed while payouts were paused). Enabling **opens** a payout window and
disabling **closes** it (`referral_payout_windows`, committed atomically with the
switch). An order earns a commission **only if it completed inside an active
window** — a paused-period order falls in a window gap and is never paid, even
after re-enable. The `referral_commissions_started_at` horizon is kept as the
earliest window start (display + the "never before the first enable" floor).
Backward-compatible: an install enabled under the old code (horizon, no windows)
synthesises a single open window from the horizon.

### 9.2 The eight fixes

| # | Severity | Fix |
|---|----------|-----|
| 1 | Critical | `runClawbackStep` now locks the **Referral row before the User row** — the same `Referral → User` order the credit path uses — so a concurrent credit and reversal can never deadlock. |
| 2 | High | `applyReferralIfEligible` verifies a pre-existing `Referral` row's referrer matches (check-then-create under the serialising claim) and **rolls the whole claim back on a mismatch**, so `User.referrerId` and `Referral.referrerUserId` can never disagree. |
| 3 | Medium | The worker scan-lock token gains a random suffix, so two scans in the same millisecond can't mint the same token and release each other's lock. |
| 4 | P1 | Enabling stamps the horizon, opens the window, and flips the switch **in one transaction** — a crash can never leave an orphan horizon that would later back-fill. |
| 5 | P1 | Orders completed while payouts were paused are excluded by the active-window gate (engine) and the window-range scan filter (worker) — never back-filled. |
| 6 | P1 | The reversal scan runs **regardless of the enabled switch** and is commission-driven, so a refund whose live enqueue was lost while payouts were paused is still reversed. |
| 7 | P1 | The credit scan has **no time floor**: it pages oldest-first over orders inside active windows, so a multi-day outage never permanently drops an eligible order. The engine writes a terminal `CANCELLED` marker for in-window orders that yield no payout (self-referral, below minimum, zero/first-purchase-consumed), so the scan converges instead of re-selecting them forever. |
| 8 | P2 | The duplicate-`orderId` preflight now runs **before** the `CREATE UNIQUE INDEX` inside `20260719180000` (not only in the later standalone guard), so a legacy database with duplicates fails with the actionable message instead of PostgreSQL's opaque index error. |

Regression + concurrency coverage lives in
`apps/bot/tests/referral-review-blockers.test.ts`.
