# Telegram Stars Subscription — Refunds & Reconciliation

## Definite failure → Telegram refund (never wallet)

When Telegram charged the user but the renewal **definitely** cannot be fulfilled
(`executeRenewalOrder` returned refunded — the 0-Toman order FAILED with **no**
wallet movement), the charge is marked `REFUND_PENDING` and
`refundStarsSubscriptionCharge` runs:

1. `refundStarPayment(user_id, telegram_payment_charge_id)` for the **exact**
   failed charge id — never a different cycle's.
2. Compare-and-set `REFUND_PENDING → REFUNDED` (idempotent: a confirmed refund is
   never re-called). Bounded retry on API failure
   (`telegram_stars_subscription_refund_max_attempts`, default 5).
3. `editUserStarSubscription(..., is_canceled = true)` to stop future extension.
4. Subscription → `REQUIRES_ACTION`; best-effort user notice.

**No `WalletTransaction` is ever created for a Stars refund**, and the raw
Telegram response is never persisted.

## Unknown panel outcome → reconcile before refund

If the panel result is uncertain, the charge is `RECONCILIATION_REQUIRED` and the
Order stays PAID/PROVISIONING for the **existing read-after-write reconciliation**
to complete (if the renewal applied) or refund on **authoritative proof of
non-application**. Invariant: an unknown outcome never yields both a Service
renewal AND a Stars refund.

## Recovery after restart

The durable charge/subscription rows make refunds and settlement resumable: a
`REFUND_PENDING` charge is retried, a `FULFILLING` charge with an Order re-drives
fulfilment only, and the worker recovery jobs re-scan.
