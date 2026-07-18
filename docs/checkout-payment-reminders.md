# Checkout & Payment Reminders (Notification Engine — Phase 2)

Branch: `feat/checkout-payment-reminders` · Both rules **disabled by default**.

Phase 2 adds two notification rules on top of the Phase 1 engine (PR #99) —
**abandoned checkout** and **failed/expired online payment** reminders — reusing
the same persistent records, delivery queue, CAS delivery worker, retry/dead-
letter, quiet hours, daily limits, callback namespace, MessageTemplate/ButtonText
registries and admin health page. It does **not** create a second engine.

## What it does

- Detects checkouts a user started but never completed and, after configurable
  inactivity, sends up to two reminders with a "continue payment" action.
- Detects definitively failed/expired **online** payments and, after a delay,
  sends one retry reminder with a "reselect payment method" action.
- Lets a user silence reminders for **one** checkout without changing any global
  preference.
- Gives OWNER admins rule toggles, threshold/delay configuration, a dry-run
  audience preview and a test send.

## What it never does

A reminder can navigate the user back into an existing checkout, but neither the
scan, the delivery worker, nor any callback handler may: mark a Payment
successful, settle a CheckoutSession, create an Order, approve a receipt, spend
Wallet, reserve inventory, provision a Service, start OTHER_PRODUCT fulfillment,
credit commission, or alter reconciliation. The financial system stays
authoritative; a retry is a **new** Payment attempt on the same checkout, created
only by the existing method-selection flow after the user picks a method. Failed
Payments are immutable.

## Rules & gates

A reminder is generated only when **all** are true:

```
automated_notifications_enabled            (master, Phase 1)
AND the specific rule enabled              (abandoned / payment)
AND user.status == ACTIVE
AND user.cronNotificationsEnabled
AND user.paymentNotificationsEnabled       (PAYMENT category)
```

Settings (all seeded/defaulted disabled or code-defaulted):

| Key | Default | Meaning |
|-----|---------|---------|
| `notification_abandoned_checkout_enabled` | `false` | abandoned rule |
| `notification_payment_retry_enabled` | `false` | payment-retry rule |
| `notification_abandoned_checkout_config` | `{thresholdMinutes:[30,360],maximumRemindersPerCheckout:2,maximumCheckoutAgeHours:24}` | abandoned config |
| `notification_payment_retry_config` | `{delayMinutes:10,maximumRemindersPerPayment:1,maximumRemindersPerCheckoutPerDay:2}` | payment config |
| `notification_schedule_checkout_scan_minutes` | `10` | scan cadence |

See [abandoned-checkout-rules.md](abandoned-checkout-rules.md) and
[payment-retry-notifications.md](payment-retry-notifications.md) for the full
eligibility tables.

## Architecture (reuses Phase 1)

```
worker scan queue ── SCAN_CHECKOUT_NOTIFICATIONS (every 10m, gated on either rule)
   │  checkout-eligibility.ts  → shared evaluators (checkout-notifications.ts)
   │  creates dedupe-guarded SCHEDULED AutomatedNotification (category PAYMENT)
   ▼
delivery queue ── DELIVER_AUTOMATED_NOTIFICATION (Phase 1 worker, unchanged path)
   │  re-validates live financial state (revalidateCheckoutSource) → CANCEL if stale
   │  quiet hours + daily cap (Phase 1) → render → send with inline keyboard
   ▼
bot ── ntf:<shortId>:c|d|n  (continue / view / suppress; owner + live re-check)
```

- **One resolver**: `evaluateAbandonedCheckoutEligibility` /
  `evaluateFailedPaymentEligibility` (pure, `@zedbot/shared`) are called by the
  scan, the delivery re-validation, and the admin dry-run preview — identical
  decisions everywhere.
- **Activity**: `resolveCheckoutLastActivity` measures abandonment from the
  latest *user* activity (checkout create/update, payment attempt, receipt,
  customer-input progress), never `createdAt` alone.
- **Dedupe**: `checkout:<id>:abandoned:v1:<stage>` (one row per stage) and
  `payment:<id>:retry:v1` (one row per failed payment). The unique `dedupeKey`
  makes concurrent scans and worker restarts converge to one row.
- **Conflict policy**: a checkout with a retry-eligible failed payment is owned
  by the payment rule; the abandoned reminder is skipped (no double message).

## Delivery re-validation (stale cancellation)

Before sending, the delivery worker reloads authoritative state and CANCELS when
the reason no longer holds: checkout settled, an Order exists, a receipt is
pending review, a reconciliation case opened, a competing payment succeeded, the
checkout expired, the checkout was suppressed, the failed payment is no longer
failed, or the user re-engaged (recent activity). It reuses the same evaluators
— never trusting the notification snapshot for financial truth.

## User experience

- Reminders carry safe buttons: «ادامه پرداخت» / «انتخاب روش پرداخت» (continue →
  the existing method-selection page for that checkout), «مشاهده جزئیات سفارش» /
  «مشاهده سفارش» (checkout view), «دیگر یادآوری نکن» / «عدم یادآوری این سفارش»
  (suppress this checkout only).
- On a "continue" click the bot re-resolves the checkout owner-scoped, reloads
  live state, and either routes to the payment-method page (resumable) or shows a
  safe message (settled / expired / receipt-pending / reconciliation).

## Security

Bot token only in the request URL. Payload snapshots + callbacks carry only safe
display values (product name, payable amount, a short checkout reference,
payment-method label) — never a full checkout/payment/user/product/panel/Telegram
id, provider authority, receipt content, card data, customer-form values or
price-per-user. Callback data is `ntf:<shortId>:<action>` (< 64 bytes). All
mutations are OWNER-only; enabling a rule passes a fail-safe activation gate.
See [notification-security.md](notification-security.md).

## Operations

Enable from admin → تنظیمات عمومی → «اعلان‌ها و یادآوری‌ها 🔔» → «یادآوری سفارش
ناقص 🛒» / «یادآوری پرداخت ناموفق 💳». See the runbook in
[notification-operations-runbook.md](notification-operations-runbook.md).

## Deferred (Phase 3+)

Customer win-back, conversion attribution/analytics, auto-renewal, automatic
wallet deduction, recurring Stars subscriptions, and automatic provider retries
are out of scope and never happen here.
