# NOWPayments integration (crypto)

Adapter: `packages/payments/src/nowpayments.ts` (`NowPaymentsGateway`).
Payments are created as **hosted invoices**; final status is driven
exclusively by **signed IPN webhooks** — there is no reliable poll by
invoice id, so `verifyPayment` reports `uncertain` instead of guessing.

## Invoice endpoint

`POST {host}/invoice` with `x-api-key`, body:
`price_amount` (invoice fiat amount), `price_currency`, `order_id` (**our
Payment id**), `order_description`, `ipn_callback_url` and optional
`success_url` / `cancel_url`. The response's `id` becomes the payment's
`authority`/`externalReference` and `invoice_url` is the redirect the user
opens.

`{host}` is `https://api.nowpayments.io/v1`, or
`https://api-sandbox.nowpayments.io/v1` with `NOWPAYMENTS_SANDBOX=true`.

Toman → fiat conversion: `price_amount = round((amountToman /
NOWPAYMENTS_TOMAN_PER_UNIT) * 100) / 100` — the operator maintains the rate.

## IPN signature rule

`POST /payments/nowpayments/ipn` (apps/api) verifies every webhook before
reading anything from it:

1. Take the **raw request body bytes** (the route registers a raw-string
   JSON parser scoped to the payment routes).
2. Parse, re-serialize with **recursively sorted object keys**.
3. `HMAC-SHA512(sorted_json, NOWPAYMENTS_IPN_SECRET)`, hex-encoded.
4. Compare timing-safely against the `x-nowpayments-ipn-signature` header.

Missing/invalid signatures (including an unset secret — unverifiable is
unauthorized) answer **401** and write nothing. `verifyIpnSignature()` is
exported for reuse and never throws.

## Status mapping

| `payment_status` | Normalized | Effect on the row |
| --- | --- | --- |
| `finished`, `confirmed` | `SUCCESS` | `providerStatus=SUCCESS`, `verifiedAt` (first time), `externalTransactionId=payment_id`; `Payment.status` untouched (the bot settles) |
| `waiting`, `confirming`, `sending`, `partially_paid` | `PROCESSING` | `Payment.status` PENDING → PROCESSING |
| `expired` | `EXPIRED` | `Payment.status` → EXPIRED (CAS from PENDING/PROCESSING) |
| `failed`, `refunded` | `FAILED` | `Payment.status` → FAILED (CAS from PENDING/PROCESSING) |
| anything else | `UNKNOWN` | **Hold for review**: sanitized payload stored, `providerStatus`/`status` untouched, 200 answered |

## Replay & ownership protection

- **Never downgrade:** once `providerStatus=SUCCESS`, non-SUCCESS replays
  are ignored; duplicate SUCCESS webhooks are idempotent no-ops
  (`verifiedAt` set once, row byte-stable).
- **Ownership:** the IPN's `order_id` must resolve to a NOWPAYMENTS payment
  row; a signed-but-unmatched IPN answers 200 (no id oracle) and writes
  nothing. If the row already carries an `externalReference`, an IPN with a
  different `invoice_id` is ignored.
- Money only moves in the bot's CAS-gated settlement — concurrent/replayed
  IPNs can never double-provision.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `NOWPAYMENTS_API_KEY` | API key (`x-api-key`). Empty ⇒ gateway unavailable |
| `NOWPAYMENTS_IPN_SECRET` | IPN HMAC secret. Empty ⇒ gateway unavailable and every IPN answers 401 |
| `NOWPAYMENTS_CALLBACK_URL` | Absolute IPN URL, e.g. `https://<APP_DOMAIN>/payments/nowpayments/ipn` |
| `NOWPAYMENTS_SANDBOX` | `"true"` routes calls to the sandbox host |
| `NOWPAYMENTS_PRICE_CURRENCY` | Fiat currency invoices are priced in (default `usd`) |
| `NOWPAYMENTS_TOMAN_PER_UNIT` | **Required rate**: toman per 1 unit of the price currency (integer > 0). Unset/invalid ⇒ gateway unavailable — the operator owns this rate and must keep it current |
| `NOWPAYMENTS_SUCCESS_URL` / `NOWPAYMENTS_CANCEL_URL` | Optional invoice redirect URLs |
| `NOWPAYMENTS_BASE_URL` | Full host override incl. `/v1` (precedence over sandbox). Test/mock hook — leave unset in production |

## Security notes

- Provider error bodies are never surfaced (only HTTP status codes) so the
  API key cannot leak through echoed request details.
- The stored `callbackPayload` keeps a whitelisted business subset
  (`payment_status`, `payment_id`, `invoice_id`, `order_id`,
  `price_amount`, `pay_currency`, `actually_paid`) — never the signature or
  any header.
