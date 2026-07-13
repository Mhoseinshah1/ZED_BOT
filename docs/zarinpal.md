# Zarinpal integration

Adapter: `packages/payments/src/zarinpal.ts` (`ZarinpalGateway`). Uses the
official **v4 REST API** with amounts in toman (`currency: "IRT"`).

## Endpoints used

| Call | Endpoint | Purpose |
| --- | --- | --- |
| Create | `POST {host}/pg/v4/payment/request.json` | Requests a payment; success (code 100) returns the `authority` |
| Redirect | `{host}/pg/StartPay/{authority}` | The URL the user opens to pay |
| Verify | `POST {host}/pg/v4/payment/verify.json` | The **only** source of truth for payment success |

`{host}` is `https://payment.zarinpal.com` in production and
`https://sandbox.zarinpal.com` with `ZARINPAL_SANDBOX=true` (the sandbox
mirrors the production route shapes).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ZARINPAL_MERCHANT_ID` | Merchant UUID. Empty ⇒ the gateway reports `isAvailable() = false` and is hidden from users |
| `ZARINPAL_CALLBACK_URL` | Absolute redirect callback, e.g. `https://<APP_DOMAIN>/payments/zarinpal/callback` |
| `ZARINPAL_SANDBOX` | `"true"` routes all calls to the sandbox host |
| `ZARINPAL_BASE_URL` | Full host override (takes precedence over the sandbox flag). Test/mock hook — leave unset in production |
| `PAYMENT_HTTP_TIMEOUT_MS` | Shared HTTP timeout for all payment providers (default 10 s) |

## Callback flow

1. The bot creates the payment (`request.json`), stores the `authority` on
   the `Payment` row (unique column) and shows the StartPay link.
2. Zarinpal redirects the user to
   `GET /payments/zarinpal/callback?Authority=...&Status=OK|NOK`
   (apps/api).
3. `Status=NOK` records `providerStatus=CANCELLED` and shows a "payment
   cancelled" page. **`Status=OK` proves nothing** — the route immediately
   calls `verify.json` and only a verified answer records
   `providerStatus=SUCCESS` + `ref_id` (as `externalTransactionId`).
4. Recording never settles: `Payment.status` stays PENDING/PROCESSING until
   the bot's settlement transaction runs (check-status button or the sweep).
5. An unknown `Authority` answers a 404 page; malformed callbacks answer 400.

## Result code semantics

| Code | Meaning | Handling |
| --- | --- | --- |
| `100` | Verified now | `SUCCESS` + `ref_id` |
| `101` | Already verified before | `SUCCESS` again — Zarinpal's built-in duplicate-verification protection makes verify idempotent server-side; replayed callbacks leave the row stable |
| other | Definite failure | `FAILED` (never uncertain) |
| — (timeout/transport/malformed) | Could not determine | `PENDING` with `uncertain: true` — **never** treated as failure; a later verify resolves it |

If the redirect is lost entirely, `settleGatewayPayment` runs the same
verify on demand for Zarinpal payments (the "check status" fallback), so a
paid user can always complete checkout.

## Security notes

- The merchant id never appears in logs, adapter results, error messages or
  stored payloads (only numeric result codes are surfaced).
- The callback records only `{Authority, Status}` as the sanitized payload.
- The amount passed to verify is the payment's `payableAmountToman`; the
  settlement additionally refuses any payment whose amounts do not equal
  the checkout's `finalPriceToman`.
- The redirect callback is unauthenticated by design (Zarinpal offers no
  signature); this is safe because the callback never grants anything — the
  server-side verify call is the only trust anchor.
