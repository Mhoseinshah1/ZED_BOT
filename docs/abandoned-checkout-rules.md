# Abandoned Checkout Reminder Rules (Phase 2)

How the scan decides whether a `CheckoutSession` gets its next abandoned-checkout
reminder. The decision is the pure `evaluateAbandonedCheckoutEligibility`
(`@zedbot/shared`), called identically by the worker scan, the delivery
re-validation and the admin dry-run preview.

## Inactivity, not age

Abandonment is measured from the **latest meaningful user activity**, resolved by
`resolveCheckoutLastActivity` from the safe timestamps:

- `CheckoutSession.createdAt` / `updatedAt`
- latest `Payment.createdAt` / `updatedAt` on the checkout
- latest `ManualReceipt.createdAt`
- latest `CheckoutCustomerInput.updatedAt`

Background/worker timestamps are never passed in. The resolver returns a
`SafeCheckoutActivityReason` (e.g. `payment_attempt`) that carries no receipt
text, form answers, provider payload, card data or credentials.

## Stages

Default `thresholdMinutes = [30, 360]`, `maximumRemindersPerCheckout = 2`.

- Stage `N` is sent only when the checkout already has exactly `N-1` abandoned
  reminders **and** inactivity ≥ `thresholdMinutes[N-1]`.
- Stage 1 → 30 minutes inactive; stage 2 → 6 hours inactive.
- Never more than `maximumRemindersPerCheckout` reminders per checkout **lifetime**
  (counted across worker restarts via the persisted rows, not an in-memory
  counter).
- Never after `maximumCheckoutAgeHours` (default 24h) from creation.

Each stage has its own dedupe key `checkout:<id>:abandoned:v1:<stage>`, so a
repeated or concurrent scan never creates a duplicate, and a stage that already
has a row (any status) advances the count.

## Eligibility (all must hold)

| # | Condition |
|---|-----------|
| 1 | master + abandoned rule enabled |
| 2 | user ACTIVE + cron + payment category enabled |
| 3 | checkout owned by the user |
| 4 | `status == PENDING` |
| 5 | `settledByPaymentId == null` |
| 6 | no Order for the checkout |
| 7 | no Payment with `settlementStatus = SETTLED` |
| 8 | no Payment with `settlementStatus = DUPLICATE_SUCCESS_REVIEW` |
| 9 | no `PENDING_REVIEW` payment (card-to-card receipt awaiting review) |
| 10 | no `APPROVED` receipt |
| 11 | no OPEN/IN_REVIEW `FinancialReconciliationCase` |
| 12 | not expired (`status != EXPIRED` and `expiresAt > now`) |
| 13 | not `CANCELLED` / `FAILED_REFUNDED` |
| 14 | checkout suppression not active |
| 15 | inactivity ≥ the stage threshold |
| 16 | reminder count < max |
| 17 | checkout age ≤ max age |

Exclusion reasons returned (also used as the preview breakdown + the delivery
cancel `safeErrorCode`): `cancelled`, `expired`, `settled`, `order-exists`,
`receipt-pending`, `receipt-approved`, `duplicate-success`, `reconciliation`,
`suppressed`, `too-old`, `max-reached`, `too-early`, `not-pending`.

## Receipt & reconciliation exclusions

A customer who has **sent a receipt** is waiting for the operator, not
abandoning — a `PENDING_REVIEW` payment excludes the checkout. An `APPROVED`
receipt means it is paid. An open reconciliation case (duplicate success under
review) always blocks reminders.

## Suppression

The «دیگر یادآوری نکن» button stamps
`CheckoutNotificationPreference.abandonedReminderSuppressedAt` for that one
checkout — never the user's global switch and never another checkout. Repeated
clicks are idempotent; history is never hard-deleted.

## Delivery re-validation

At send time the worker reloads the checkout and re-runs the evaluator with the
stage pinned; if the checkout became settled/expired/order/receipt-pending/
reconciled/suppressed, or the user re-engaged (recent activity fails the stage
threshold), the reminder is CANCELLED before any message is sent.

## Conflict with payment retry

A checkout that also has a retry-eligible failed online payment is owned by the
payment-retry rule (when enabled); the scan skips the equivalent abandoned
reminder so the user never gets two messages about the same unresolved checkout.
