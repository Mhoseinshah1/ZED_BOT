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
