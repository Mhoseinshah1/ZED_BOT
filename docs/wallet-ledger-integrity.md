# Wallet Ledger Integrity

Audit and hardening of every wallet balance mutation. Goal: the wallet
balance is completely reconstructable from immutable `WalletTransaction`
rows, and no payment, refund, manual adjustment, retry or concurrent
execution can corrupt the ledger.

## The ledger

`WalletTransaction` is an append-only journal. Each row records:

- `amountToman` (always positive), `type`, `source`, `reason`
- `balanceBeforeToman` / `balanceAfterToman` - the exact transition the
  row's transaction performed
- `relatedOrderId` / `relatedPaymentId` / `adminId` - the business anchor

No production code path updates or deletes a `WalletTransaction`
(verified: zero `walletTransaction.update/delete/upsert` call sites).

## Mutation inventory

Every write to `User.balanceToman` in the codebase (verified by sweeping
all Prisma writes and all raw SQL - there are exactly seven, in five
services):

| # | Operation | Type | Site |
|---|-----------|------|------|
| 1 | Wallet order payment (purchase / renewal / extra volume / extra time) | `SPEND` | `apps/bot/src/services/wallet-payment.service.ts` (`executeWalletOrderPayment`) |
| 2 | Wallet top-up approval | `CHARGE` | `apps/bot/src/services/receipt-review.service.ts` (`approveWalletTopup`) |
| 3 | Provisioning-failure refund | `REFUND` | `apps/bot/src/services/provisioning.service.ts` (`failOrderWithRefund`) |
| 4 | Admin manual add | `MANUAL_ADD` | `apps/bot/src/services/admin-user-wallet.service.ts` (`adjustUserWallet`) |
| 5 | Admin manual deduct | `MANUAL_DEDUCT` | same as 4 |
| 6 | Referral affiliate commission **credit** | `COMMISSION` | `apps/bot/src/services/referral-commission.service.ts` (`creditReferralCommissionForOrder`) |
| 7 | Referral commission **clawback** (refunded order) | `SYSTEM_ADJUSTMENT` | same file (`runClawbackStep`) |

All seven run inside a single `prisma.$transaction` that also writes the
ledger row - the balance change and its journal entry commit or roll back
together, so a successful mutation always has exactly one row and a failed
mutation has none.

### Referral commission clawback debit semantics (mutation #7)

`type = SYSTEM_ADJUSTMENT` with `source = REFERRAL` is **always a referral
commission clawback DEBIT** (never a credit): it reverses a `COMMISSION` /
`REFERRAL` credit whose source order was refunded. It never drives a normal wallet
negative — the clawback recovers only what the balance affords (`allowNegativeBalance`
users excepted), so one refund may produce **several** partial debit rows over time
as the referrer's wallet gains funds. The authoritative recovery total lives in the
`ReferralCommission` row (`recoveredToman`, `recoveryOutstandingToman`, bounded by a
CHECK `0 ≤ recovered ≤ amount`); the debit rows are the immutable ledger evidence.
The commission row's `reversalWalletTransactionId` points at the FIRST such debit.
Concurrent reversals/recoveries serialise on the commission row lock, so the sum of
clawback debits for one order **never exceeds** the original credit.

**Reconstruction rule:** a user's balance is still exactly the running sum of
`± amountToman` over their `WalletTransaction` rows in `createdAt`/lock order, with
`SYSTEM_ADJUSTMENT` + `REFERRAL` counted as a debit and `COMMISSION` as a credit.
No referral row is ever edited or deleted in a way that touches the ledger; pruning
an old terminal `ReferralCommission` row (retention cleanup) leaves the ledger
untouched.

## Invariants and how each is enforced

1. **One immutable ledger row per mutation** - the row is created in the
   same transaction as the balance write; nothing edits rows afterwards.
2. **`balance == last balanceAfter`** - every site derives
   `balanceAfter` from the row-locked post-update value (see "The locked
   read-back pattern" below), so the pair describes the real transition in
   lock (serialization) order.
3. **`balanceAfter = balanceBefore ± amount`** - each site computes one
   side from the other and the amount; the integration tests assert the
   arithmetic per type for every row.
4. **Rows are never edited** - no update/delete call sites exist.
5. **No row disappears after success** - same-transaction commit.
6. **No duplicate row per logical operation** - see "Idempotency".
7. **Every mutation carries a business reason** - `WALLET_ORDER_PAYMENT`,
   `WALLET_TOPUP`, `REFUND_PROVISIONING_FAILED`, or the admin's mandatory
   free-text reason (3..500 chars) plus `adminId`.
8. **Refunds are idempotent** - see "Refunds".
9. **Failed operations mutate nothing** - aborts are thrown inside the
   transaction (`WalletPaymentAbort`, `ReviewAbortError`, `AdjustAbort`)
   and roll back every row including the ledger entry.
10. **The ledger reconstructs the balance** - see "Reconstruction".

## The locked read-back pattern

Correct ledger values under concurrency come from one rule: **never
record a balance you read before taking the row lock.**

- Debits (`SPEND`, `MANUAL_DEDUCT`) use a conditional
  `updateMany({ where: { id, balanceToman: { gte: amount } } })`.
  PostgreSQL re-evaluates the condition on the committed row under the row
  lock, so overdraft is impossible (0 matched rows aborts the whole
  transaction). The updated row is then read back inside the same
  transaction - still locked - and `balanceBefore = after + amount`.
- Credits (`CHARGE`, `REFUND`, `MANUAL_ADD`) use a single
  `update({ data: { balanceToman: { increment } } })` whose *returned row*
  provides the post-update balance; `balanceBefore = after - amount`.

### Bugs found and fixed by this audit

`approveWalletTopup` and `failOrderWithRefund` previously read
`balanceBefore` with a plain (non-locking) `findUniqueOrThrow` *before*
applying the increment. A concurrent wallet operation committing between
that read and the increment made the recorded `balanceBefore`/`balanceAfter`
pair describe a transition that never happened: the final balance stayed
correct (increments are atomic), but `balance != last balanceAfter` and
the ledger chain no longer reconstructed. Both sites now use the locked
read-back pattern (the increment `UPDATE ... RETURNING` provides the
post-update value). These were the only two defects found; the other three
sites already followed the pattern.

## Idempotency

- **Wallet payment**: `Payment.idempotencyKey = wallet:<userId>:<nonce>`
  (unique constraint). A retried or concurrently duplicated draft hits the
  key and gets the first settled result back (`alreadyPaid`) - the balance
  is never deducted twice and no second `SPEND` row is written.
- **Top-up approval**: the `PENDING_REVIEW -> APPROVED` payment flip is a
  compare-and-set `updateMany`; only the winning approval proceeds to the
  credit. A `findFirst` on `relatedPaymentId + WALLET_TOPUP` is a second
  net. A payment never returns to `PENDING_REVIEW`, so at most one
  `CHARGE` row can ever exist per top-up.
- **Refund**: only the caller whose compare-and-set flips the order to
  `FAILED` creates the refund, and an existing refund row for the order
  short-circuits. Retrying is a no-op that still reports success.
- **Manual adjustments**: the admin confirmation draft is consumed from
  the session *before* executing, so a double-clicked confirm finds no
  draft. The service itself performs plain atomic adjustments and creates
  only a `WalletTransaction` - never Orders, Payments or Services.

## Concurrency

Verified by integration tests racing real transactions
(`apps/bot/tests/wallet-ledger.test.ts`):

- **Two simultaneous wallet payments** on funds covering one: the
  conditional deduction serializes on the user row; exactly one settles,
  the loser rolls back completely. No negative balance, no lost update.
- **Payment + top-up approval on the same user**: both serialize on the
  user row lock; both ledger rows record real transitions and the chain
  stays gapless (this is the exact scenario the fixed stale-read bug used
  to corrupt).
- **Payment + admin adjustment, overdraft races**: same row-lock
  serialization; the balance can never go below zero because every debit
  re-checks `balanceToman >= amount` under the lock.
- **Double approval / double refund**: compare-and-set status flips make
  one caller the owner; the loser aborts before touching money.

## Refunds

One refund → one `REFUND` ledger row → one balance increase → one order
status transition (`PAID`/`PROVISIONING` → `FAILED`). Retrying
`failOrderWithRefund` for the same order (sequentially or concurrently)
never creates a second row: the order flip is compare-and-set and the
existing refund row short-circuits. Fully-discounted (0-toman) orders flip
to `FAILED` without a ledger row - there is no money to move.

## Reconstruction

The balance is reconstructable from the ledger alone:

```
balance(user) = Σ +amountToman  for type in {CHARGE, REFUND, CASHBACK, COMMISSION, MANUAL_ADD}
                Σ -amountToman  for type in {SPEND, MANUAL_DEDUCT}
```

(starting from the account's initial balance, which is 0 by schema
default). Additionally the rows form one gapless chain: every row's
`balanceBeforeToman` equals another row's `balanceAfterToman` (or the
starting balance), ending at the current balance.

Note on ordering: `createdAt` is the *transaction start* timestamp
(PostgreSQL `now()`), so under concurrency it may not match the
commit/serialization order. Reconstruction therefore chains rows by
matching before/after balances (as the integration test does), or simply
sums signed amounts - it must not assume `createdAt` order equals lock
order.

## Remaining limitations

- **Immutability is enforced at the application layer.** No code path
  edits ledger rows, but the database itself would still allow an `UPDATE`
  from a manual psql session. DB-level enforcement (a `BEFORE UPDATE OR
  DELETE` trigger raising an exception) would require a migration and is
  intentionally out of scope for this hardening pass.
- **No DB unique constraint on (relatedPaymentId, reason) / (relatedOrderId,
  reason).** Duplicate prevention rests on the compare-and-set status
  flips, which are sound (a payment/order can never re-enter the state
  that permits creating the row). A partial unique index would add
  defense-in-depth at the cost of a migration; not required for
  correctness today.
- **Manual-adjustment idempotency is session-scoped.** The consumed
  confirmation draft prevents double-clicks; there is no DB-level
  idempotency key for admin adjustments. Two independently issued,
  identical adjustments are legitimately two operations.
- **`DEBT_ADD` / `CASHBACK` / `COMMISSION` types exist in the enum but have
  no creation path yet** (future phases: representative debt, cashback,
  referral payouts). When implemented they must follow the same
  transaction + locked read-back pattern; `claimDiscountUsage`-style
  shared helpers are the model.
- **Stats counters (`totalChargedToman`, `totalSpentToman`, ...) are
  informational**, not part of the ledger guarantee; they move with their
  operation's transaction but are not reconstructed from the ledger.
