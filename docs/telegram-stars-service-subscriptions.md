# Telegram Stars Service Subscriptions (Automatic Renewal — Phase 2)

Recurring **30-day** VPN Service renewals funded directly through **Telegram Stars
subscriptions** (`XTR`, `subscription_period = 2592000`). A user opts one eligible
Service into a subscription-enabled 30-day renewal Product, reviews the fixed
recurring Stars amount and terms, approves the subscription invoice, and Telegram
then charges the same fixed Stars amount every 30 days. Each charge renews the
**existing Service in place** — never a replacement Service, never above the fixed
amount, never a double renewal for one Telegram charge.

> **Disabled by default.** Requires BOTH the existing one-time Stars gateway
> switch (`TELEGRAM_STARS_ENABLED`) AND the new
> `telegram_stars_subscriptions_enabled` setting.

> **Scope.** Only SERVICE_RENEWAL of an existing eligible Service. **No** generic
> recurring purchases, **no** OTHER_PRODUCT subscriptions, **no** wallet funding
> for Stars charges (the internal wallet is never touched for a Stars subscription).

---

## Architecture audit (pre-implementation)

### Baseline
- `origin/main` HEAD = `3520cb5` = merge of **PR #104** (wallet auto-renewal /
  Phase 1). PRs #99–#104 merged. Branch: `feat/telegram-stars-service-subscriptions`.

### Existing Telegram Stars (one-time) — preserved unchanged
- `packages/payments/src/telegram-stars.ts` — `TelegramStarsGateway`.
  `STARS_PAYLOAD_PREFIX = "zedbot:pay:"`, `parseStarsPayload`. `createPayment`
  computes a **`sendInvoice`**-shaped `telegramInvoice` (title/description/payload/
  currency `XTR`/`stars`) from a Toman amount via `tomanPerStar`. No HTTP API —
  events arrive as bot updates. `verifyPayment` returns uncertain (bot updates are
  authoritative).
- `apps/bot/src/handlers/stars-payment.handler.ts` — `starsPaymentHandler`
  (registered BEFORE gates/flow-router in `app.ts`). `pre_checkout_query`:
  `validateStarsPreCheckout` (owner telegramId, live PENDING/PROCESSING+unexpired,
  `XTR`, exact stored stars). `message:successful_payment`:
  `recordProviderSuccessFromBot` (charge id + currency + amount only — never the
  full payload) → `settleGatewayPayment` → `fulfillSettledGatewayOrder`.
- These paths key entirely on the `zedbot:pay:` prefix and a **local Payment id**.

### Phase-1 mandate architecture — extended, not duplicated
- `ServiceAutoRenewalMandate` (`serviceId @unique`) is the **exclusivity
  authority**: one Service → at most one automatic-renewal mandate. Phase 1 is
  implicitly wallet-only (no funding-method column). Phase 2 adds
  `AutoRenewalFundingMethod { WALLET, TELEGRAM_STARS }` and
  `fundingMethod @default(WALLET)`, so existing rows backfill to `WALLET`.
- The worker **wallet** scan (`apps/worker/src/auto-renewal/scan.ts`) selects
  `status = ACTIVE` mandates. Phase 2 **must** add `fundingMethod = WALLET` to that
  filter so a Stars mandate is never processed by the wallet charger. (Defense in
  depth: the execute engine also skips non-WALLET mandates.)
- Wallet-specific mandate fields (`maximumChargeToman`, `consentedPriceToman`) are
  not applicable to a Stars mandate; a Stars mandate stores `0` there (the wallet
  scan never reaches it). The Stars amount lives on the subscription model.

### Reuse targets (no second implementation)
- **Fulfillment**: `dispatchPaidOrderFulfillment(api, orderId, {source, user})`
  (`order-fulfillment.service.ts`) → `executeRenewalOrder` for `SERVICE_RENEWAL`
  (in-place renewal, existing refund on definite failure, existing reconciliation
  on uncertain panel outcome). Phase 2 settlement dispatches through this — no new
  renewal executor.
- **Renewal snapshot / eligibility**: `renewal-checkout.service.ts`
  (`isRenewalPlanValid`, `renewalPlansForPanel`, `buildRenewalSnapshot`,
  `getRenewableServiceByShortId`).
- **Service concurrency**: the per-service Redis lock inside `executeRenewalOrder`
  serializes a recurring charge against a manual renewal.
- **Notifications**: the wallet auto-renewal precedent (`auto-renewal.service.ts`)
  sends best-effort `api.sendMessage` notices; a delivery failure never rolls back
  a settlement. Phase 2 follows the same best-effort pattern.

### The core divergence from one-time Stars
- One-time uses `sendInvoice` keyed on a **Payment id** in the payload. A
  subscription must use **`createInvoiceLink`** with `subscription_period` and a
  **non-enumerable** payload (`zedbot:sub:<publicPayloadId>`), because a later
  recurring `successful_payment` arrives with **no pre-created local checkout** and
  the SAME payload but a NEW `telegram_payment_charge_id`. So the local financial
  chain (Payment/Checkout/Order) is created **per Telegram charge id**, keyed on
  the charge model's `telegramPaymentChargeId @unique`, not on a payload id.

### Idempotency spine
```
one telegram_payment_charge_id
  → one TelegramStarsSubscriptionCharge   (@unique)
  → at most one Payment                    (@unique)
  → at most one CheckoutSession            (@unique)
  → at most one SERVICE_RENEWAL Order      (@unique)
  → at most one applied renewal
one failed charge → at most one refund (refundStarPayment on the exact id)
```
The authoritative first charge id (`initialTelegramPaymentChargeId`) is what
`editUserStarSubscription` requires for cancel/reactivate — never a later local id.

### Official Bot API constraints treated as hard requirements
- Enrollment invoice: `createInvoiceLink` + `currency=XTR` +
  `subscription_period=2592000` + exactly one `LabeledPrice`; amount `1..10000`.
- `SuccessfulPayment` safe fields only: `currency`, `total_amount`,
  `invoice_payload`, `telegram_payment_charge_id`, `provider_payment_charge_id`,
  `subscription_expiration_date`, `is_recurring`, `is_first_recurring`. Never the
  full update, never `order_info`.
- `editUserStarSubscription(user_id, charge_id, is_canceled)` for cancel/reactivate.
- `refundStarPayment(user_id, charge_id)` for the exact failed charge.
- `getStarTransactions` only as a bounded recovery mechanism (lost-update replay).

The remainder of this document is expanded as the implementation lands (see the
sibling docs: `telegram-stars-subscription-payments.md`, `-refunds.md`,
`-operations.md`, `-concurrency.md`, and the Phase 2.1 additions
`-recovery.md`, `-support.md`, `-reporting.md`).

---

## Phase 2.1 — subscription recovery & operations (PR beyond #105)

Phase 2.1 (`feat/stars-subscription-recovery-operations` off `origin/main`
@ `782904b`) completes the operational scope deferred by Phase 2. It adds, all
behind the same master switch and disabled by default:

- **Bot API 10.2 subscription-state Updates** (`active` / `canceled` / `failed`)
  via a pre-gate handler and a minimal compat shim (`Update.subscription` is not
  yet in `@grammyjs/types@3.28.0`); **refunded-payment Updates**.
- A durable **transaction cursor** (`TelegramStarsReconciliationCursor`
  singleton) + `getStarTransactions`-based **charge recovery** — settles charges
  Telegram genuinely made but whose live update was lost, never fabricating a
  subscription.
- **Recovery evidence** (`LIVE_SUCCESSFUL_PAYMENT` vs `STAR_TRANSACTION_RECOVERY`)
  and **exact-vs-derived expiration** (`LIVE_EXACT` vs `RECOVERED_DERIVED`), with
  live/recovery **convergence** onto one settled charge (no double renewal).
- **PAST_DUE** detection (recoverable), bounded **refund retries**, and
  **fulfillment reconciliation** of stuck charges.
- A **producer/consumer split**: the worker owns discovery/scheduling and produces
  money-touching jobs onto the bot-consumed `stars-subscription-execute` queue;
  the bot consumer runs them with the existing idempotent settlement/refund
  services (mirrors wallet auto-renewal).
- **Reactivation** UI, admin **product configuration** + version-drift reporting,
  an admin **dashboard** with manual reconcile, **`/paysupport`**, a Stars
  **financial report**, cleanup/retention, and operational logging.

Full detail: `telegram-stars-subscription-recovery.md` (cursor, recovery, evidence,
PAST_DUE, refunds, engine, producer/consumer, rollback), `-support.md`
(`/paysupport`), `-reporting.md` (financial report). The `-payments` / `-refunds` /
`-operations` / `-concurrency` docs carry their own Phase 2.1 sections.
