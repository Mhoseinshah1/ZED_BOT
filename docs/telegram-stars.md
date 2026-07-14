# Telegram Stars integration (XTR)

Adapter: `packages/payments/src/telegram-stars.ts` (`TelegramStarsGateway`);
bot handlers: `apps/bot/src/handlers/stars-payment.handler.ts`. There is no
provider HTTP API: invoices go out through the Bot API and payment events
arrive as bot updates.

## Invoice creation

`createPayment` computes the `bot.api.sendInvoice` parameters (it performs
no I/O):

- `currency: "XTR"`, one price item with `stars` = `max(1,
  ceil(amountToman / tomanPerStar))`,
- `payload` = `zedbot:pay:<paymentId>` (`STARS_PAYLOAD_PREFIX`) — the only
  link between the Telegram invoice and our `Payment` row; it is also
  stored as the payment's `authority`,
- `title` capped at Telegram's 32-character limit.

The integer `stars` amount is persisted in the payment's `callbackPayload`
at creation and re-checked at pre-checkout. Stars invoices take **no
provider token**.

## Payload format

`zedbot:pay:<payment uuid>` — parsed back with `parseStarsPayload()`, which
returns `null` for anything without the exact prefix or with an empty id.
Foreign/garbage payloads are therefore ignored everywhere.

## Pre-checkout validation (the last veto point)

Telegram sends `pre_checkout_query` right before charging; answering `true`
is irreversible. `validateStarsPreCheckout(payment, query)` (exported, pure)
requires ALL of:

1. the payload parses and the payment row exists with
   `provider = TELEGRAM_STARS`,
2. the payment belongs to the paying Telegram user (`user.telegramId ===
   query.from.id`),
3. `Payment.status` is PENDING or PROCESSING (terminal/settled/review rows
   are dead),
4. the payment is not expired (`expiresAt` in the future or null),
5. `query.currency === "XTR"`,
6. `query.total_amount` equals **exactly** the stars amount stored at
   creation (missing/invalid stored amount ⇒ reject).

Anything else answers `ok=false` with a safe Persian error; handler crashes
also answer `false` (never silently let a charge through).

## successful_payment settlement

On `message:successful_payment` (registered BEFORE access gates and flow
routers so a paid user can always complete checkout):

1. Currency must be XTR and the payload must resolve to an owned
   TELEGRAM_STARS payment; otherwise the update is logged and dropped.
2. `recordProviderSuccessFromBot` records `providerStatus=SUCCESS`,
   `verifiedAt` (set once), `externalTransactionId =
   telegram_payment_charge_id` and a sanitized payload
   (`currency` + `total_amount` only).
3. `settleGatewayPayment` runs the CAS-gated settlement; Telegram's
   redelivered updates land as idempotent "already" outcomes — one Order,
   one wallet credit, `verifiedAt` stable.

## Stored fields

Only the **charge id** (`telegram_payment_charge_id`), currency and
`total_amount` are persisted — never the full `successful_payment` payload
(it can carry order-info/user data that has no business here).

## Configuration

| Setting | Meaning |
| --- | --- |
| `TELEGRAM_STARS_ENABLED` (env) | `"true"` enables the gateway; anything else ⇒ `isAvailable() = false` |
| `StarsPricingSetting` (DB singleton) | The toman/star rate. The gateway is only available in `MANUAL_RATE` mode with a positive `manualTomanPerStar`; the rate is passed into `buildDefaultManager({ starsTomanPerStar })` by the bot (never read from env). `AUTO_RATE_API` is not implemented — without a manual rate Stars stays hidden |

Availability is re-read on the manager's ~30 s cache cycle, so admin rate
edits take effect quickly. Since Telegram offers no payment-status poll,
`verifyPayment` reports `uncertain` — bot updates are authoritative and the
sweep settles any recorded SUCCESS the handler missed.
