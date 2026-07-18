# Failed / Expired Payment Retry Reminders (Phase 2)

How the scan decides whether a definitively-failed **online** `Payment` gets a
retry reminder. The decision is the pure `evaluateFailedPaymentEligibility`
(`@zedbot/shared`), called identically by the scan, the delivery re-validation
and the admin preview. A retry reminder navigates the user to reselect a payment
method; it never mutates the failed Payment and never settles anything.

## Which payments qualify

The Payment must be locally `FAILED` or `EXPIRED` (the normalized definitive
outcomes), `settlementStatus != SETTLED`, attached to a CheckoutSession, owned by
the user, and its provider must be an **online** provider where a fresh attempt
is meaningful:

```
PAYMENT_RETRY_PROVIDERS = ZARINPAL, NOWPAYMENTS, TELEGRAM_STARS,
                          AGHAYEPARDAKHT, PLISIO, CUSTOM
```

**Excluded providers:** `CARD_TO_CARD` (a rejected manual receipt is an
operator-reviewed business event that stays in its own direct flow) and `WALLET`
(no online provider / no definitive failed Payment to retry). A rejected manual
receipt never produces a `PAYMENT_RETRY`.

## Whole-checkout inspection (race safety)

The scan inspects the entire checkout, not just the one Payment. A retry is
suppressed when any of these hold — the same checks re-run at delivery time:

| Reason | Condition |
|--------|-----------|
| `not-failed` | payment no longer FAILED/EXPIRED (e.g. moved to SUCCESS) |
| `excluded-provider` | CARD_TO_CARD / null provider |
| `settled-locally` | the payment itself is SETTLED |
| `settled` | `settledByPaymentId != null` or checkout status != PENDING |
| `order-exists` | an Order exists for the checkout |
| `receipt-pending` | a `PENDING_REVIEW` payment on the checkout |
| `reconciliation` | an OPEN/IN_REVIEW reconciliation case |
| `competing-success` | another payment SETTLED / DUPLICATE_SUCCESS_REVIEW / providerStatus SUCCESS |
| `expired` | the checkout expired |
| `suppressed` | `paymentRetrySuppressedAt` set |
| `too-early` | less than `delayMinutes` since the failure |
| `max-per-payment` | already `maximumRemindersPerPayment` (default 1) for this payment |
| `max-per-checkout-day` | already `maximumRemindersPerCheckoutPerDay` (default 2) in the last 24h |

Race behaviors guaranteed:

- Failed payment scanned → another provider succeeds → the retry is CANCELLED
  before delivery (competing-success / settled).
- Retry reminder clicked → another provider already succeeded → no new Payment is
  created; the resume flow shows the already-paid result.
- Two failed providers on one checkout → the per-checkout daily cap prevents
  spam.

## Dedupe & caps

- `payment:<id>:retry:v1` — one reminder per definitively-failed Payment (unique
  `dedupeKey`; repeated webhook updates for the same failure never duplicate).
- `maximumRemindersPerCheckoutPerDay` — a **database-authoritative** count of
  `PAYMENT_RETRY` rows for the checkout in the last 24h (never an in-memory
  counter).
- A payment moving `PROCESSING → FAILED` becomes eligible once; `FAILED → SUCCESS`
  before delivery cancels the reminder.

## Payment-method reselection

The «انتخاب روش پرداخت» button routes through the resume service to the existing
`showPaymentMethods` page for the same checkout. The button set is built from
current availability (`getAvailablePaymentMethods`): disabled/hidden/group-
restricted/out-of-range gateways are absent, and the previous failed Payment is
never a selectable transaction. A new Payment is created only after the user
picks a method (the existing flow), preserving one settlement owner per checkout.
If no gateway is currently available, the reminder shows a safe "no active
method" message with view-order + support — it never cancels the checkout.

## Message safety

The message shows only product name, payable amount, a short checkout reference
and a payment-method label. It never shows raw provider errors, never claims the
provider did or did not charge the user, and never says the money was lost.
