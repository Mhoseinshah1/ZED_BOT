# Atomic Discount Consumption

Fixes the race condition where two concurrent payments using the same
discount code could both pass validation and exceed `totalUsageLimit` or
`perUserUsageLimit`.

## The original race condition

Discount limits were checked in two places, and **neither check was
race-safe**:

1. `validateDiscountCode()` ran **before** payment (checkout preview and
   again at the top of every wallet-payment entry point). It read
   `totalUsedCount` and the per-user `DiscountCodeUsage` count with plain
   reads, outside any transaction.
2. Inside the payment transaction (wallet settle in
   `wallet-payment.service.ts`, receipt approval in
   `receipt-review.service.ts`), the code only checked *per-checkout
   idempotency* (`findFirst({ checkoutSessionId })`), then unconditionally
   created the `DiscountCodeUsage` row and incremented `totalUsedCount`.

The window: with a code at `totalUsedCount = limit - 1`, two payments
running concurrently both read the stale count, both pass validation, and
both increment - final state `limit + 1`, i.e. the code is over-consumed.
The same applied to `perUserUsageLimit` (one user racing two different
orders) and to codes deactivated or expired between validation and
settlement. Wallet payments were the easiest to race (a double tap on two
different pre-invoices), but two admins approving two receipts that used the
same code hit the identical window.

## Chosen solution

All limit enforcement moved into a single shared function,
`claimDiscountUsage(tx, args)` in `apps/bot/src/services/discount.service.ts`,
executed **inside** the existing payment transaction at both call sites:

- `executeWalletOrderPayment()` - the one transaction shared by all four
  wallet entry points (purchase, renewal, extra volume, extra time). A
  failed claim throws `WalletPaymentAbort`, rolling back the order, payment
  and balance deduction together.
- `approveReceiptPayment()` (ORDER_PAYMENT approvals). A failed claim
  throws `ReviewAbortError`, rolling back the approval - the payment stays
  `PENDING_REVIEW` so the admin can reject it with a reason.

`claimDiscountUsage` does, in order:

1. **Idempotency short-circuit** (unchanged rule): if a
   `DiscountCodeUsage` row already exists for this `checkoutSessionId`,
   return `alreadyClaimed` without touching the code row. Retried or
   re-approved payments never double-count.
2. **Row lock**: `SELECT ... FOR NO KEY UPDATE` on the `DiscountCode` row.
   Every claim for one code serializes on this lock.
3. **Re-validation under the lock**: `isActive`, `startsAt`/`expiresAt`
   window, `totalUsageLimit` vs `totalUsedCount`, and the per-user
   `DiscountCodeUsage` count vs `perUserUsageLimit` - all against the
   latest committed state.
4. **Claim**: create the `DiscountCodeUsage` row and increment
   `totalUsedCount` with a guarded `updateMany({ where: { id, isActive: true } })`
   that fails the claim if it does not match exactly one row.

`validateDiscountCode()` is unchanged and now explicitly UX-only: it gives
the user an early, friendly Persian error at checkout, but the payment
transaction never trusts it.

### Why `FOR NO KEY UPDATE` and not `FOR UPDATE`

By the time the claim runs, the surrounding transaction has already inserted
rows (`CheckoutSession`, `Order`) whose `discountCodeId` foreign keys hold
`FOR KEY SHARE` on the code row. `FOR UPDATE` conflicts with the *other*
payment's `KEY SHARE`, so two concurrent payments deadlock (PostgreSQL
40P01: each holds `KEY SHARE`, each waits for `FOR UPDATE`).
`FOR NO KEY UPDATE` does not conflict with `KEY SHARE` but still conflicts
with itself, which is exactly what is needed: claimers exclude each other,
FK inserts are unaffected. (This is also the lock a plain `UPDATE` of a
non-key column takes.) The integration tests reproduced the deadlock with
`FOR UPDATE` and pass with `FOR NO KEY UPDATE`.

### Lock ordering

The wallet flow locks the user row (balance deduction) before the discount
row; receipt approval locks the payment row before the discount row. The
discount row is always the *last* lock taken, in both flows, so no cycle
between the two flows is possible.

## Why this is atomic

- The usage row, the `totalUsedCount` increment, the order, the payment and
  the money movement all commit in **one** PostgreSQL transaction. A failed
  or rolled-back payment consumes nothing; a settled discounted payment
  always has its claimed usage.
- The limit check and the increment happen under the same row lock, so the
  check can never act on a stale count: concurrent claimers queue on the
  lock and each one re-reads the state left behind by the previous
  *committed* claim (READ COMMITTED locked reads always see the latest
  committed row version).
- Idempotency is enforced twice: at most one `DiscountCodeUsage` per
  checkout (checked first inside the claim), and at most one settled wallet
  payment per draft (`Payment.idempotencyKey` unique constraint, resolved
  via the P2002 replay path before the claim is ever reached).

Proven by `apps/bot/tests/discount-atomic.test.ts` (PostgreSQL integration
tests): two users racing a limit-1 code (exactly one wins, loser fully
rolls back including the wallet balance), one user racing
`perUserUsageLimit = 1`, two users racing the last remaining usage
(limit 2, one pre-consumed), a failed payment consuming nothing, a retried
draft claiming once, concurrent same-draft duplicates claiming once, two
concurrent receipt approvals on a limit-1 code (the losing payment stays
`PENDING_REVIEW`), and a double-approved payment keeping a single usage.

## Remaining limitations

- **`allowedGroups` / `appliesTo` are not re-checked under the lock.** They
  are enforced by the pre-payment validation only. Unlike usage counters
  they are not consumed by concurrent payments - a race can only matter if
  an admin edits the code's audience in the milliseconds between validation
  and settlement, and the outcome (one grandfathered order) is harmless.
  The claim does re-check `isActive` and the time window, so
  deactivating/expiring a code takes effect immediately.
- **Claims for one code serialize.** Under heavy concurrent load on a
  single discount code, payments queue on the row lock for the few
  milliseconds the claim takes. This is inherent to any correct counter
  and irrelevant at bot scale.
- **A failed receipt approval is not auto-rejected.** When the claim fails
  during approval, the payment intentionally stays `PENDING_REVIEW` and the
  admin sees a safe Persian error explaining that the code is no longer
  valid; rejecting (with the money-return flow that entails) stays a human
  decision.
- **Future online-gateway settlement** must call `claimDiscountUsage`
  inside its settlement transaction the same way; the function is designed
  to be the single shared entry point for any new payment method.
