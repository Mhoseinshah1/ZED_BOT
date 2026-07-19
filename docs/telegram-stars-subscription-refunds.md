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

## Phase 2.1 — refunded-payment Updates, bounded retries, reconciliation

- **Refunded-payment Update (Bot API).** A `message:refunded_payment` update
  (pre-gate handler) is the refund **confirmation**: after validating `XTR` +
  `zedbot:sub:` payload → subscription, charge id → charge, amount == charge
  amount, same user and a refundable state, it marks the charge `REFUNDED`
  (idempotent CAS), moves the subscription to `REQUIRES_ACTION` + extension
  canceled, and creates a durable `STARS_SUBSCRIPTION_REFUNDED` notification. It
  is **never** a `WalletTransaction` and **never** calls `refundStarPayment`
  again. Duplicates are harmless; foreign/malformed updates are logged and
  ignored.
- **Bounded refund retries.** The worker `REFUNDS` processor selects
  `REFUND_PENDING` charges with remaining capacity → a bot-consumed `RETRY_REFUND`
  job, spaced by `telegram_stars_subscription_refund_retry_minutes` (default 30)
  up to `..._refund_max_attempts`. When retries are **exhausted**, the
  subscription is marked `REQUIRES_ACTION` — **never** a `WalletTransaction`.
- **Refund reconciliation.** Confirms **only outgoing** star transactions that
  match an existing `REFUND_PENDING` charge (same user/amount). Unknown outgoing
  transactions are ignored — recovery never invents a refund.

Full detail: `telegram-stars-subscription-recovery.md`.
