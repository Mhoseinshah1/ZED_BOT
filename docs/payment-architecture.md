# Payment gateway architecture

The online payment system (Zarinpal, NOWPayments, Telegram Stars) is built
in layers so that provider code stays provider-pure, event recording stays
separate from money movement, and settlement happens **exactly once** no
matter how many callbacks, button mashes, replays or sweeps arrive.

Related documents: [zarinpal.md](zarinpal.md), [nowpayments.md](nowpayments.md),
[telegram-stars.md](telegram-stars.md), [payment-lifecycle.md](payment-lifecycle.md).

## Layered design

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Telegram user                                                             │
│   checkout flow → «پرداخت» → Order / fulfillment                          │
└──────────────┬────────────────────────────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────────────────────────────┐
│ apps/bot — payment service layer                                          │
│   payment-method.service   which gateways this user may pay with          │
│   gateway-payment.service  payment creation, SETTLEMENT (the only place   │
│                            gateway money moves), fulfillment, sweep       │
│   stars-payment.handler    pre_checkout_query veto + successful_payment   │
│   payment.handler          gateway selection UI, «بررسی وضعیت پرداخت ♻️»   │
└──────────────┬────────────────────────────────────────────────────────────┘
               │                                     ┌──────────────────────┐
               │                                     │ apps/api             │
               │                                     │  payment-routes.ts   │
               │                                     │  verifies + RECORDS  │
               │                                     │  provider events,    │
               │                                     │  never settles       │
               │                                     └──────────┬───────────┘
┌──────────────▼────────────────────────────────────────────────▼───────────┐
│ packages/payments — PaymentGatewayManager                                 │
│   get(provider) / available()                                             │
│   ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐               │
│   │ Zarinpal    │  │ NOWPayments  │  │ Telegram Stars     │               │
│   │ v4 REST     │  │ invoice+IPN  │  │ sendInvoice params │               │
│   └─────────────┘  └──────────────┘  └────────────────────┘               │
└──────────────┬────────────────────────────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────────────────────────────┐
│ Providers: payment.zarinpal.com · api.nowpayments.io · Telegram Bot API   │
└───────────────────────────────────────────────────────────────────────────┘
```

## Package layout

| Path | Responsibility |
| --- | --- |
| `packages/payments/src/types.ts` | The provider-neutral `PaymentGateway` contract and the normalized status model |
| `packages/payments/src/zarinpal.ts` | Zarinpal v4 REST adapter (`request.json` / `verify.json` / StartPay) |
| `packages/payments/src/nowpayments.ts` | NOWPayments invoice adapter + `verifyIpnSignature` (HMAC-SHA512, sorted keys) |
| `packages/payments/src/telegram-stars.ts` | Stars XTR invoice spec + `parseStarsPayload` |
| `packages/payments/src/manager.ts` | `PaymentGatewayManager` registry + `buildDefaultManager()` (env-configured) |
| `packages/payments/src/http.ts` | Timeouts, safe JSON reading, secret-free error formatting |
| `apps/api/src/payment-routes.ts` | `GET /payments/zarinpal/callback`, `POST /payments/nowpayments/ipn` — verify + record only |
| `apps/bot/src/services/gateway-payment.service.ts` | Payment creation, `settleGatewayPayment` (the money gate), fulfillment dispatch, settlement sweep |
| `apps/bot/src/handlers/stars-payment.handler.ts` | `pre_checkout_query` validation + `successful_payment` recording/settlement |
| `apps/bot/src/handlers/admin-finance/payments-list.handler.ts` | Read-only admin payment browser (business fields only) |

`packages/payments` is **provider-pure**: it never imports the database and
never throws for expected provider failures. Callers persist adapter results
on `Payment` rows.

## Database fields added (payment-gateway-system phase)

On `Payment`:

| Field | Meaning |
| --- | --- |
| `provider` | Denormalized `PaymentGatewayType` copy — rows stay classifiable even if the gateway row changes |
| `authority` (unique) | Provider handle issued at creation: Zarinpal authority / NOWPayments invoice id / Stars invoice payload |
| `externalReference` | Provider-side payment/invoice reference when distinct from `authority` |
| `providerStatus` | The **normalized provider outcome** recorded by verified callbacks/webhooks (`SUCCESS`, `PROCESSING`, `FAILED`, `EXPIRED`, `CANCELLED`) |
| `verifiedAt` | Set exactly once, on the first recorded provider SUCCESS — stable across replays |
| `externalTransactionId` | Final settlement reference (Zarinpal `ref_id`, NOWPayments `payment_id`, Telegram charge id) |

`PaymentStatus` gained `PROCESSING` (user came back from the gateway /
provider event in flight) and `CANCELLED` (user cancelled at the gateway).

`callbackPayload` stays **sanitized**: whitelisted business fields only —
never credentials, signatures, API keys or raw provider bodies.

## Normalized status model

Adapters translate provider-specific answers into
`NormalizedPaymentStatus`; only this normalized value is recorded on
`Payment.providerStatus`:

| Normalized | Zarinpal | NOWPayments | Telegram Stars |
| --- | --- | --- | --- |
| `SUCCESS` | verify code 100 or 101 | `finished`, `confirmed` | `successful_payment` (charge id present) |
| `PROCESSING` | redirect `Status=OK` (verification still required) | `waiting`, `confirming`, `sending`, `partially_paid` | `pre_checkout_query` stage |
| `FAILED` | verify with any other definite code | `failed`, `refunded` | — |
| `EXPIRED` | — | `expired` | — |
| `CANCELLED` | redirect `Status=NOK` | — | — |
| `PENDING` (+ `uncertain`) | timeout / transport / malformed response | poll unsupported (IPN-driven) | poll unsupported (update-driven) |
| `UNKNOWN` | — | any unmapped `payment_status` → payload stored for manual review, statuses untouched | — |

`uncertain: true` means "could not determine" (timeout/transport): it is
**never** treated as failure — the payment stays PENDING and a later
verification resolves it.

## Where money moves

- **apps/api records, never settles.** The IPN/callback routes verify the
  event (HMAC signature / server-side verify call), then write
  `providerStatus`, `verifiedAt`, references and the sanitized payload. A
  recorded SUCCESS leaves `Payment.status` at PENDING/PROCESSING.
- **apps/bot settles.** `settleGatewayPayment()` is the only place gateway
  money moves (wallet credit or Order creation), mirroring the manual
  receipt-approval service. Every trigger path funnels through it: the
  «بررسی وضعیت پرداخت ♻️» button, the Stars `successful_payment` handler and
  the background sweep.

## Exactly-once design (the CAS chain)

Settlement is one transaction whose first statement is a compare-and-set:

1. **Payment CAS — the gate.** `updateMany` moves `Payment.status`
   PENDING/PROCESSING → APPROVED. Matching 0 rows means another settle won
   (or the payment is terminal): the caller resolves to an idempotent
   "already" outcome. Only the CAS winner proceeds.
2. **Checkout CAS.** `CheckoutSession` PENDING → PAID. 0 rows here with no
   existing order aborts the transaction (another payment already paid this
   checkout).
3. **Purpose-specific money move.**
   - `WALLET_CHARGE`: balance increment + one `WalletTransaction`, guarded
     by `relatedPaymentId` + reason — a replay finds the existing ledger row
     and credits nothing.
   - `ORDER_PAYMENT`: **create-or-reuse** — an existing order for the
     checkout is linked, never duplicated; user stats
     (`ordersCount`/`paidOrdersCount`/`totalPurchaseAmountToman`) move only
     with the single creation.
4. **Discount finalization — deliberate divergence.** The receipt/wallet
   paths abort on a failed discount claim because they abort *before* money
   moves. Here the user already paid the discounted amount at an external
   provider, so a failed claim keeps the settlement and flags the order
   (`adminNote`) for manual review instead — stranding real money is worse
   than an over-claimed code.

Guards in front of the transaction: amount equality
(`payment.amountToman == payment.payableAmountToman == checkout.finalPriceToman`
— tampered rows return an error and settle nothing), terminal-status
short-circuits, and a manual-review (`PENDING_REVIEW`) exclusion.

## Settlement sweep

`runGatewaySettlementSweep()` (one run per minute, `startGatewaySettlementLoop`):

1. **Pass 1:** settle + fulfill payments whose provider SUCCESS was recorded
   but never settled (bot was down, user never pressed the button).
2. **Pass 2 (crash recovery):** re-fulfill APPROVED order payments whose
   order stayed PAID ≥ 2 minutes (settled but fulfillment crashed).
   Fulfillment executors are CAS-claimed/idempotent, so repeats are safe.
3. **Expiry:** PENDING gateway payments 30+ minutes past `expiresAt` with no
   provider event flip to EXPIRED (again a CAS via the status filter).

## Adding a future provider

1. Implement `PaymentGateway` (`packages/payments/src/<provider>.ts`):
   `isAvailable`, `createPayment`, `verifyPayment`, `handleCallback`,
   `getPaymentStatus`. Never throw for expected failures; never put
   credentials in results, errors or payloads; report transport uncertainty
   with `uncertain: true` instead of failing.
2. Register it in `manager.ts`: add the name to `SupportedProvider` /
   `SUPPORTED_ONLINE_PROVIDERS` and wire it in `buildDefaultManager()` with
   a `<provider>ConfigFromEnv()` reader (missing env ⇒ `isAvailable()`
   false, never a crash).
3. Add the env vars to `.env.example` and, if the provider pushes webhooks,
   a verify-and-record route in `apps/api/src/payment-routes.ts` that calls
   `recordProviderOutcome` — never settles.
4. The provider value must exist in the `PaymentGatewayType` Prisma enum so
   admin gateway rows can carry it; the bot side (creation, settlement,
   sweep, admin list) picks it up through the manager automatically.
