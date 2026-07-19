# Telegram Stars Subscription — Payments & Settlement

How a recurring Telegram Stars charge becomes a local financial chain and an
in-place Service renewal. See `telegram-stars-service-subscriptions.md` for the
architecture and `-refunds.md` / `-operations.md` / `-concurrency.md` siblings.

## Invoice (enrollment)

Enrollment builds the invoice with **`createInvoiceLink`** (never the one-time
`sendInvoice`), via the pure `buildStarsSubscriptionInvoice()` in
`packages/payments`:

- `currency = XTR`, `subscription_period = 2592000` (the only supported period),
- exactly one `LabeledPrice` of the fixed `starsAmount` (1..10000),
- payload `zedbot:sub:<publicPayloadId>` — a cryptographically-random,
  non-enumerable id carrying no user/service/product id, no price, no secret.

The bot then `ctx.api.createInvoiceLink(..., { subscription_period })` and sends a
URL button. Repeated clicks reuse the same live PENDING_PAYMENT enrollment.

## SuccessfulPayment (initial + recurring)

The subscription handler (registered pre-gate, after the one-time handler which
now **defers** `zedbot:sub:` payloads) processes only the safe fields:
`currency`, `total_amount`, `invoice_payload`, `telegram_payment_charge_id`,
`provider_payment_charge_id`, `subscription_expiration_date`, `is_recurring`,
`is_first_recurring`. **Never** the raw update, **never** `order_info`.

It requires `currency = XTR`, `is_recurring = true` and a
`subscription_expiration_date`, matches the paying user, and hands off to the
central settlement.

## Central settlement — `settleTelegramStarsSubscriptionCharge`

The idempotency spine is `TelegramStarsSubscriptionCharge.telegramPaymentChargeId
@unique`:

```
one telegram_payment_charge_id
  → one charge row (create-or-load; CAS RECEIVED→SETTLING claim)
  → one PAID CheckoutSession + one APPROVED Payment + one PAID SERVICE_RENEWAL Order
    (all @unique on the charge; committed atomically)
  → dispatchPaidOrderFulfillment(source: GATEWAY) → executeRenewalOrder (in place)
```

- The Order carries **0 Toman** — Stars revenue lives on the charge, so Stars
  never inflates Toman reports and the reused wallet-refund path is a no-op.
- The Order snapshots (`durationDaysSnapshot`, `volumeGbSnapshot`) come from the
  **frozen entitlement** captured at enrollment, so every cycle applies the fixed
  contract, not a mutated live Product.
- The first charge records `initialTelegramPaymentChargeId` (required by
  `editUserStarSubscription`) and moves `currentPeriodEndsAt` /
  `nextExpectedChargeAt` to `subscription_expiration_date`.
- On the renewal succeeding: charge `COMPLETED`, subscription `ACTIVE`, best-effort
  success notice.
- A duplicate Telegram update for the same charge id returns the existing
  outcome — no second Payment/Order/renewal.

## Outcomes

| Fulfilment result | Charge status | Then |
| --- | --- | --- |
| renewal applied | `COMPLETED` | subscription `ACTIVE`, notice |
| definite failure (refunded) | `REFUND_PENDING` | Stars refund flow (see `-refunds.md`) |
| uncertain panel outcome | `RECONCILIATION_REQUIRED` | existing reconciliation completes/refunds on proof |
| amount != fixed / bad snapshot | `IGNORED` / `FAILED` | never settled |
