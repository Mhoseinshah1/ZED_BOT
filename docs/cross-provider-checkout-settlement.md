# Cross-provider checkout settlement

P0 settlement hardening: one `CheckoutSession` can be paid through several
independent providers (Zarinpal, NOWPayments, Telegram Stars, card-to-card
receipt, wallet), and **nothing used to stop two of those payments from both
succeeding at their provider**. This document is the authoritative
description of the fix: the checkout — not the payment — is now the
financial gate, and exactly one payment can ever own its settlement.

Related documents: [payment-architecture.md](payment-architecture.md),
[payment-lifecycle.md](payment-lifecycle.md),
[financial-reconciliation.md](financial-reconciliation.md),
[database-invariants.md](database-invariants.md).

Code: `apps/bot/src/services/gateway-payment.service.ts`
(`settleGatewayPayment`),
`apps/bot/src/services/financial-reconciliation.service.ts`,
migration `20260715062734_atomic_checkout_settlement`. Proven by
`apps/bot/tests/cross-provider-settlement.test.ts`.

## The original race

A user opens one pre-invoice, starts **Payment A** at Zarinpal, gets
impatient (or the redirect is slow) and starts **Payment B** at NOWPayments
for the same checkout. Both providers collect real money and both report
SUCCESS. Each `Payment` row's own compare-and-set
(PENDING/PROCESSING → APPROVED) passes — they are *different rows* — so the
per-payment CAS never saw the conflict. Pre-fix outcomes:

- **Order purchase:** the second settlement's checkout flip
  (PENDING → PAID) matched 0 rows, but the order path did not treat that as
  an error — it silently *reused* the existing order and flipped its own
  payment APPROVED too. Final state: one order, **two APPROVED payments**,
  the user charged twice, and nothing anywhere flagging it.
- **Wallet charge:** the second settlement aborted on the failed checkout
  flip and rolled back. The payment stayed PENDING/PROCESSING with
  `providerStatus = SUCCESS`, which is exactly the sweep's pass-1 selection
  — so the sweep retried it **every minute, forever**, failing identically
  each time. The user's real money was stranded invisibly in a retry loop.

Neither outcome refunded, credited, or told anyone anything.

## Provider success vs local settlement

The fix separates two truths that were previously conflated:

| Field | Answers | Values |
| --- | --- | --- |
| `Payment.providerStatus` | *"Did the provider collect money?"* | `SUCCESS`, `PROCESSING`, `FAILED`, `EXPIRED`, `CANCELLED` |
| `Payment.settlementStatus` | *"What did WE do about it locally?"* | `UNSETTLED`, `SETTLED`, `DUPLICATE_SUCCESS_REVIEW` |

`providerStatus = SUCCESS` is **never downgraded** — a real external charge
stays truthfully recorded no matter what happens locally (this rule
predates the fix and is unchanged). What is new is that a provider success
no longer implies a local settlement: a duplicate charge keeps its provider
SUCCESS *and* its `Payment.status` (PENDING/PROCESSING), while
`settlementStatus` records that this payment lost the settlement and went
to financial review. `settledAt` and `settlementReason` (a short safe
English marker, never provider payloads) complete the picture.

## Checkout settlement ownership

`CheckoutSession.settledByPaymentId` is **THE claim**: the one payment
allowed to move money for this checkout.

- **Written by a compare-and-set on NULL**: the claim `updateMany` is
  filtered on `settledByPaymentId: null` *and* `status: PENDING`, so under
  any concurrency exactly one writer matches.
- **Unique** (`@unique`): the database itself refuses a second owner — and,
  because the column stores the payment id, one payment can own at most one
  checkout.
- **Every settlement path writes it**: gateway settlement claims it first
  (below), the admin receipt approval and wallet top-up approval claim it
  inside their approval transaction (`receipt-review.service.ts`), and the
  wallet order payment sets it on the checkout it creates in the same
  transaction (`wallet-payment.service.ts`). A later gateway success against
  a receipt- or wallet-settled checkout is therefore classified as a
  duplicate, never a re-settle.
- Legacy/ambiguous rows are NULL (see the migration notes in
  [financial-reconciliation.md](financial-reconciliation.md)).

## The atomic claim algorithm

`settleGatewayPayment` runs (after the usual terminal-status
short-circuits, the Zarinpal verify-on-demand fallback and the amount
guard) **one transaction**:

1. **Claim.** `updateMany` on the checkout:
   `WHERE id = <checkout> AND settledByPaymentId IS NULL AND status = PENDING`
   → `settledByPaymentId = <payment>, status = PAID, paidAt = now`.
2. **On count 0, re-read the checkout** (same transaction):
   - checkout gone → abort (error outcome, everything rolls back);
   - `settledByPaymentId` = **this** payment → same-owner crash-recovery
     retry: fall through, every later step is idempotent for the owner;
   - anything else (another payment owns it, or a pre-claim-era/legacy
     settlement left no owner while the checkout is not claimable) → throw
     `DuplicateSuccess` — the losing path below.
3. **Owner-only payment flip.** `updateMany` the payment
   PENDING/PROCESSING → `APPROVED` + `settlementStatus = SETTLED` +
   `settledAt`/`paidAt`/`reviewedAt`. Count 0 here means the *same* payment
   finished in a concurrent call → resolve to the idempotent "already"
   outcome.
4. **The money move**, by purpose:
   - `WALLET_CHARGE`: credit `balanceToman`/`totalChargedToman` and write
     one `CHARGE` `WalletTransaction`, guarded by the
     `relatedPaymentId + reason` lookup (a resumed owner credits nothing
     twice).
   - `ORDER_PAYMENT`: find-or-create the checkout's single PAID `Order`.
     Creation goes through `createOrderIdempotent`: a P2002 on the unique
     `Order.checkoutSessionId` means a concurrent transaction won — re-read
     the winner, verify it belongs to the same checkout and user, reuse it.
     User stats move only with the actual creation.
5. **Discount claim** (`claimDiscountUsage`, same divergence as before: a
   failed claim flags the order for review instead of rolling back money
   that was already collected externally).

All five steps commit or roll back **together**: there is no observable
state where the claim exists without its money move.

### The losing path

`DuplicateSuccess` is caught *outside* the settlement transaction (which
has fully rolled back) and handled by `recordDuplicateSuccess()` — a
separate, itself-atomic transaction that:

- CAS-marks the payment `settlementStatus`
  UNSETTLED → `DUPLICATE_SUCCESS_REVIEW` (+ `settlementReason`), touching
  neither `Payment.status` nor `providerStatus`;
- files **exactly one** `FinancialReconciliationCase`, keyed by the unique
  `duplicatePaymentId` (an existing case is returned; a racing filer's
  P2002 resolves to the winner). The `created` flag is true only on the
  call that actually created the case — callers notify on that call only.

A payment already marked `DUPLICATE_SUCCESS_REVIEW` short-circuits at the
top of `settleGatewayPayment`: its existing case is returned idempotently,
with no provider re-verification and no retry of provisioning or credits.

## Winner / loser behaviour

| | Winner (claim succeeded) | Loser (claim shows another owner) |
| --- | --- | --- |
| Order purchase | Payment APPROVED + SETTLED, the checkout's one PAID Order created (or reused), stats bumped once, discount claimed, fulfillment dispatched | No order, no stats, no discount; payment stays PENDING/PROCESSING with provider SUCCESS; `DUPLICATE_SUCCESS_REVIEW` + one reconciliation case |
| Wallet charge | Payment APPROVED + SETTLED, balance credited exactly once with its `CHARGE` ledger row | No credit, no ledger row; same duplicate marking + case |
| User sees | The normal success/fulfillment message | «پرداخت شما در درگاه با موفقیت ثبت شد، اما این پیش‌فاکتور قبلاً با روش دیگری پرداخت شده است…» (financial-review notice) |
| Admins see | Nothing special (normal settled log) | One-time OWNER alert + the case in the reconciliation queue |

## Duplicate-success policy: FINANCIAL_REVIEW

The duplicate's money is deliberately **not** moved automatically:

- **No automatic refund.** There is no uniform, audited, idempotent refund
  API across Zarinpal, NOWPayments and Telegram Stars. An automatic refund
  path would have to be provider-specific, partially unverifiable, and a
  brand-new place where money moves without a human — the exact class of
  risk this phase removes.
- **No automatic wallet credit.** Silently converting a duplicate charge
  into wallet balance changes the user's entitlement without business
  approval (and would need its own refund story anyway).

Instead the duplicate is made **loud and durable**: a persistent
`FinancialReconciliationCase`, a user notice, and an OWNER admin alert.
Resolution (refund at the provider, manual wallet credit, or keep) is a
human decision recorded through the reconciliation queue — see
[financial-reconciliation.md](financial-reconciliation.md).

## Crash windows

| Window | State in the DB | Recovery |
| --- | --- | --- |
| Provider SUCCESS recorded, settlement never started (bot down, user never pressed the check button) | `providerStatus = SUCCESS`, status PENDING/PROCESSING, `settlementStatus = UNSETTLED` | Sweep pass 1 selects exactly this shape and settles it |
| Crash *inside* the settlement transaction | Nothing — claim, flip and money move roll back together | The next trigger (button, IPN, sweep) re-runs from scratch |
| Settlement committed, fulfillment/notification crashed | Checkout owned, payment APPROVED + SETTLED, order PAID | Sweep pass 2 re-fulfills PAID orders after the 2-minute grace; a retried settle resolves through the same-owner path / "already" outcome |
| Duplicate detected, crash before the notification was sent | The case and the `DUPLICATE_SUCCESS_REVIEW` marker are already committed (they precede any send) | Retries return the same case with `created = false` — the notification is never a reason to re-file; user-triggered paths re-show the notice, and the admin queue is the durable surface |
| Process killed mid-race between two payments | At most one `settledByPaymentId` — the CAS + unique constraint decided before anything else happened | The loser's next settlement attempt files (or returns) its case |

## Idempotency rules

| Scenario | Outcome |
| --- | --- |
| Same payment settled twice concurrently (double click, IPN + button, sweep + button) | One transaction wins; the other hits count 0 on the owner-only flip and resolves to "already". Money moves once |
| Same payment retried after `SETTLED` | Terminal short-circuit (`status = APPROVED`) → "already", order/balance untouched |
| Two payments with provider SUCCESS on one checkout | Exactly one claims; the other gets `DUPLICATE_SUCCESS_REVIEW` + one case. Never two orders, never two credits |
| Retry after `DUPLICATE_SUCCESS_REVIEW` (sweep would loop here pre-fix) | Short-circuit returns the existing case (`created = false`); the sweep's pass 1 filters on `settlementStatus = UNSETTLED` and never selects the row again |
| Same provider event replayed | `verifiedAt` set once, providerStatus never downgraded (unchanged rules); a transaction id already attached to another payment is refused by `@@unique(provider, externalTransactionId)` — no SUCCESS on reused evidence |

## Remaining limitations

- **No automatic refund** — by policy (above). Duplicate money leaves the
  system only through a human decision.
- **Receipt approval on an already-owned checkout aborts to the admin**
  rather than filing a case: `approveReceiptPayment`'s checkout CAS
  (`status PENDING AND settledByPaymentId IS NULL`) matching 0 rows rolls
  the approval back and shows the admin «وضعیت پیش‌فاکتور برای تایید معتبر
  نیست.» — correct (no double settle, receipt money hasn't moved yet, the
  admin can reject with a reason), but the admin is not routed into the
  reconciliation queue automatically.
- **RBAC centralization is a separate task.** The reconciliation queue and
  the duplicate alerts use OWNER as the strongest financial role available
  today; a centralized role/permission system is out of scope here.
