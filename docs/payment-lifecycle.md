# Payment lifecycle — checkout to fulfillment

The exact life of a payment for every method. Money invariants:

- **Nothing is ever provisioned before a verified success** — no Service,
  no Order, no wallet credit, no stock delivery.
- Gateway money moves **only** inside `settleGatewayPayment`'s CAS-gated
  transaction; manual receipts move money only inside the admin approval
  transaction; wallet spends only inside the wallet-payment transaction.
- Every settlement path is idempotent and replay-safe.

## States

`Payment.status` (ours) vs `Payment.providerStatus` (the recorded,
normalized provider outcome — gateway payments only):

| Payment.status | Meaning |
| --- | --- |
| `PENDING` | Created; awaiting user action / provider events |
| `PENDING_REVIEW` | Manual receipt submitted; awaiting an admin (card-to-card only) |
| `PROCESSING` | Provider event in flight (user returned from gateway, IPN `confirming`, …) |
| `APPROVED` | **Settled — money moved.** Terminal-success |
| `REJECTED` | Admin rejected the manual receipt |
| `FAILED` | Definite provider failure / provider create failed |
| `EXPIRED` | Never completed before expiry (checkout expiry + 30 min grace for gateways) |
| `CANCELLED` | User cancelled at the gateway (Zarinpal NOK) |
| `DELETED` | Admin-hidden |

`providerStatus ∈ {SUCCESS, PROCESSING, FAILED, EXPIRED, CANCELLED}` (plus
unmapped events held for review). `providerStatus=SUCCESS` with
`status=PENDING/PROCESSING` means "verified, not yet settled" — the sweep or
the user's check button finishes the job. `verifiedAt` is set exactly once.

### The duplicate-success path (P0 settlement phase)

A third axis, `Payment.settlementStatus` (`UNSETTLED` / `SETTLED` /
`DUPLICATE_SUCCESS_REVIEW`), records the **local** settlement truth. When a
provider SUCCESS arrives for a checkout that another payment already
settled (`CheckoutSession.settledByPaymentId` owned by someone else), the
payment gets `settlementStatus=DUPLICATE_SUCCESS_REVIEW` — **terminal
locally**: `providerStatus` stays SUCCESS (never downgraded),
`Payment.status` stays PENDING/PROCESSING, but the row never settles, the
sweep skips it (pass 1 filters on `settlementStatus=UNSETTLED`), and
retries idempotently return its `FinancialReconciliationCase`. The
reconciliation queue owns it from there — no automatic refund, no
automatic wallet credit. See
[cross-provider-checkout-settlement.md](cross-provider-checkout-settlement.md)
and [financial-reconciliation.md](financial-reconciliation.md).

## Per-method lifecycle

### Wallet (balance spend)

```
draft → [one transaction: CheckoutSession PAID + Payment(PAY_WITH_WALLET) APPROVED
         + Order PAID + conditional balance deduction + SPEND ledger row]
      → fulfillment executor
```
Atomic check-and-deduct (`balanceToman >= amount` re-evaluated under the row
lock); the losing concurrent draft rolls back completely. Duplicate clicks
resolve through `Payment.idempotencyKey`.

### Card-to-card (manual receipt)

```
checkout PENDING → user picks card gateway → submits receipt
  → Payment PENDING_REVIEW + ManualReceipt        (no money, no order)
  → admin approves → [transaction: payment APPROVED (CAS) + checkout PAID
                      + Order PAID + discount claim]  → fulfillment
  → admin rejects  → payment REJECTED               (nothing ever moved)
```

### Zarinpal

```
checkout PENDING → getOrCreateGatewayPayment: Payment PENDING (authority, StartPay URL)
  → user pays → redirect callback (apps/api):
        Status=NOK → providerStatus CANCELLED, status CANCELLED
        Status=OK  → server-side verify.json:
             code 100/101 → providerStatus SUCCESS + ref_id (+ verifiedAt); status stays PENDING/PROCESSING
             other code   → providerStatus FAILED, status FAILED
             timeout      → uncertain: row untouched, stays PENDING
  → settlement (check button / sweep; verify-on-demand fallback if the redirect was lost)
  → fulfillment
```

### NOWPayments

```
checkout PENDING → Payment PENDING (invoice id, invoice_url)
  → user pays crypto → signed IPNs (apps/api):
        finished/confirmed → providerStatus SUCCESS (+ payment_id, verifiedAt); status untouched
        confirming/…       → status PROCESSING
        failed/refunded    → status FAILED
        expired            → status EXPIRED
        unmapped           → payload stored for review, nothing else
  → settlement (sweep / check button — no polling exists)
  → fulfillment
```

### Telegram Stars

```
checkout PENDING → Payment PENDING (payload zedbot:pay:<id>, stars stored)
  → sendInvoice (XTR) → pre_checkout_query → validateStarsPreCheckout (last veto)
  → successful_payment → recordProviderSuccessFromBot (charge id, verifiedAt once)
  → settleGatewayPayment (same update handler) → fulfillment + success reply
```

## Settlement (shared by all gateway methods)

```
settleGatewayPayment:
  terminal? APPROVED → "already"; FAILED/EXPIRED/CANCELLED/REJECTED/DELETED → "failed"
  settlementStatus DUPLICATE_SUCCESS_REVIEW → "duplicate" (existing case, terminal locally)
  providerStatus != SUCCESS?  Zarinpal → verify now; others → "pending"
  amount guard: payment.amount == payable == checkout.finalPriceToman, else "error"
  ONE transaction:
    CLAIM checkout: CAS settledByPaymentId NULL + PENDING → this payment + PAID
      (owned by another payment → duplicate success: mark DUPLICATE_SUCCESS_REVIEW
       + file ONE FinancialReconciliationCase, outside this rolled-back tx)
    CAS payment PENDING/PROCESSING → APPROVED + SETTLED   (losers → "already")
    WALLET_CHARGE: credit balance + one WalletTransaction (guarded by relatedPaymentId)
    ORDER_PAYMENT: create-or-reuse ONE Order PAID (unique checkoutSessionId backstop)
                   + user stats (on create only)
    discount claim (failure flags the order, never rolls back external money)
```

Fulfillment then dispatches to the same idempotent executors the receipt
approval uses (provisioning, renewal, extra volume/time, stock/manual
delivery) and sends the user's success text.

### Trial-to-paid conversion (trial-lifecycle phase)

When the target of a renewal / extra-volume / extra-time order is a
`FREE_TRIAL` service, the executor's **persist transaction** — the same
one that updates the `Service`, completes the `Order` and writes the
operation's event anchor — additionally calls `markTrialConversion`: a
CAS on `Service.convertedToPaidAt IS NULL` stamps
`convertedToPaidAt` + `firstPaidOrderId` and writes one
`TRIAL_CONVERTED_TO_PAID` event, exactly once across replays, retries
and races. Startup reconciliation's `completeReconciledMutation` makes
the same call inside its own transaction, so a mutation recovered from
panel truth converts too — the CAS keeps the executor/reconciler race
safe. The fulfillment dispatch sends the one-time notice «سرویس تست شما
با موفقیت به سرویس فعال تبدیل شد ✅» **only** when the executor outcome
carries `trialConverted === true` (replays return `alreadyApplied` and
never re-enter that branch; reconciliation never notifies). See
`docs/free-trial-lifecycle.md`.

## Forbidden transitions

- **Never a Service/Order/credit before a verified success** (`providerStatus
  SUCCESS` for gateways, admin approval for receipts, balance deduction for
  wallet).
- `APPROVED` is only ever written by a settlement/approval transaction —
  the API routes must never produce it.
- `providerStatus` never downgrades from `SUCCESS`; a `FAILED`/`EXPIRED`
  event after `SUCCESS` is ignored (replay protection).
- **A checkout settles at most once.** A second provider SUCCESS against an
  owned checkout goes to financial review (`DUPLICATE_SUCCESS_REVIEW`) —
  never a second order, credit or settlement, and never an automatic
  refund.
- Rows whose provider ever reported SUCCESS are never recycled by the
  retry/revive path.
- An expired payment's status is not moved by late provider events (the
  outcome is still recorded for manual review).
- `PENDING_REVIEW` rows never enter gateway settlement.

## Failure / expiry / cancel paths

- **Provider create fails** → payment FAILED immediately (nothing exists
  provider-side); the row is revived to PENDING on the user's next attempt.
- **Definite verify failure** (Zarinpal non-100/101) → FAILED; uncertain
  results (timeouts) keep the row PENDING for a later verify.
- **User cancels at Zarinpal** → CANCELLED; a fresh attempt revives the row.
- **Expiry** → checkout expiry propagates to the payment `expiresAt`; the
  sweep flips stale event-less PENDING rows to EXPIRED after a 30-minute
  grace.
- **Fulfillment failure after settlement** (panel down, …) → the executors'
  own refund/turn-back logic applies; the sweep's pass 2 re-runs stuck PAID
  orders after 2 minutes.

## Admin visibility

«لیست پرداخت‌ها 💳» under مالی 💎 (`payments-list.handler.ts`): read-only
browser with status filters (all / successful / pending / failed) and
provider filters (Zarinpal / crypto / Stars), plus a per-payment detail
page showing business fields — amounts, statuses, purpose, timestamps and
the external settlement reference. Gateway config, API keys, signatures and
authorities are never displayed. Manual receipts keep their existing review
flow; financial reports include settled gateway payments like any other
approved payment.
