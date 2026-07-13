# @zedbot/payments

Provider-pure online payment gateway integrations. Each gateway implements
the shared `PaymentGateway` contract (`createPayment`, `verifyPayment`,
`handleCallback`, `getPaymentStatus`, `isAvailable`):

- **Zarinpal** — official v4 REST API (`request.json` / `verify.json`).
  Redirect callbacks alone never mean success; `verifyPayment` is the source
  of truth (code 101 = already-verified, treated as success).
- **NOWPayments** — hosted invoice API; final status is driven exclusively
  by HMAC-SHA512-signed IPN webhooks (`verifyIpnSignature`).
- **Telegram Stars** — no HTTP; `createPayment` computes `sendInvoice`
  parameters and the bot feeds payment updates through `handleCallback`.

`refund()` is deliberately absent: Zarinpal v4 and Telegram Stars offer no
general-purpose merchant refund API we can support uniformly, and
NOWPayments refunds are a manual dashboard operation.

This package never imports the database — callers persist gateway results on
`Payment` rows. All HTTP uses global `fetch` with `AbortSignal.timeout`
(default 10 s, override with `PAYMENT_HTTP_TIMEOUT_MS`). Credentials are
read from env by the `*ConfigFromEnv()` helpers and never appear in logs,
errors or results.
