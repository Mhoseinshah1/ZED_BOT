# Telegram Stars Subscription — Recovery & Worker Operations (Phase 2.1)

Phase 2.1 completes the operational scope deferred by Phase 2 (PR #105): a
durable **transaction cursor**, `getStarTransactions`-based **charge recovery**,
Bot API 10.2 **subscription-state Updates**, refunded-payment Updates, PAST_DUE
detection, bounded refund retries, fulfillment reconciliation, and the
producer/consumer split that lets the worker own discovery while the bot keeps
the single money-touching implementation.

Base branch: `feat/stars-subscription-recovery-operations` off `origin/main`
@ `782904b` (PR #105 merged). See `telegram-stars-service-subscriptions.md` for
the Phase 2 architecture and the `-payments` / `-refunds` / `-operations` /
`-concurrency` / `-support` / `-reporting` siblings.

> **Disabled by default.** Everything here is gated by the existing master switch
> `telegram_stars_subscriptions_enabled` (plus the one-time gateway switch). When
> the switch is off, the engine removes **all** schedulers and every in-flight
> job is a dormant no-op — see [Rollback](#rollback).

---

## Bot API audit — what is native vs. shimmed

Audited against `@grammyjs/types@3.28.0` (grammy 1.44.0):

- **Native** (used directly): `getStarTransactions` / `StarTransaction` /
  `TransactionPartnerUser` (with `transaction_type` including `"invoice_payment"`)
  / `RefundedPayment` / `refundStarPayment` / `editUserStarSubscription`.
- **Not yet in the installed types**: `Update.subscription` /
  `BotSubscriptionUpdated` (Bot API 10.2). A minimal local compat shim
  (`extractSubscriptionUpdate` in
  `apps/bot/src/handlers/user-stars-subscription/stars-subscription-updates.handler.ts`)
  reads the raw update to surface the new field. **This shim is to be removed
  when upstream `@grammyjs/types` exposes Bot API 10.2.**

Telegram's default `getUpdates` already delivers the new `subscription` update
(only `chat_member` / `message_reaction(_count)` are excluded by default), so
**no `allowed_updates` change was needed**.

---

## Subscription-state Updates (Bot API 10.2, Part B)

`stars-subscription-updates.handler.ts` is a **pre-gate** handler (registered in
`app.ts` after the payment handlers, before the access/maintenance gates). It
processes **only** `zedbot:sub:` payloads and is ownership-validated. It persists
**only** the safe state string + a timestamp — never raw Update data.

| Update state | Action | Notification |
| --- | --- | --- |
| `canceled` | `CANCEL_AT_PERIOD_END` + `telegramExtensionCanceled` + **preserve** `currentPeriodEndsAt` (no refund / Payment / Order) | `STARS_SUBSCRIPTION_CANCELLED` |
| `active` | `REACTIVATION_ALLOWED` — **only if** a first charge id exists AND no active WALLET mandate; never claims a payment, never extends the Service | — |
| `failed` | `PAST_DUE` | `STARS_SUBSCRIPTION_PAST_DUE` |

Safe columns written: `lastSubscriptionUpdateState`, `subscriptionUpdateAt`,
`pastDueMarkedAt`.

## RefundedPayment Updates (Part C)

`message:refunded_payment` handler, also pre-gate. It validates: `XTR` +
`zedbot:sub:` payload + payload→subscription + charge id→charge + amount == charge
amount + same user + refundable state. On success it marks the charge `REFUNDED`
(idempotent CAS), moves the subscription to `REQUIRES_ACTION` + extension
canceled, and creates a durable `STARS_SUBSCRIPTION_REFUNDED` notification. It is
**never** a `WalletTransaction` and **never** calls `refundStarPayment` again
(this update *is* the refund confirmation). Duplicates are harmless; foreign or
malformed updates are logged and ignored.

---

## Centralized Bot API client (Part D)

The worker's `apps/worker/src/telegram.ts` gained
`getStarTransactions(offset?, limit?)`:

- HTTPS, **20 s** `AbortController` timeout, one transient retry honoring a `429`
  `retry-after`, safe error classification, validated response shape.
- `limit` clamped to `1..100`.
- The bot token appears **only in the request URL** — never logged, never in an
  error or return value.
- The raw Telegram response is **never persisted** — only a safe, normalized
  subset is used.

The bot side uses grammy's native `refundStarPayment` / `editUserStarSubscription`
(no worker HTTP for those).

---

## Transaction cursor & recovery (Parts E/F/G/H)

Worker `apps/worker/src/stars-subscription/recovery.ts`. Offset pagination bounded
by `maxPagesPerRun` (default 10) × `pageSize` (default 100).

### Cursor / offset semantics

The `TelegramStarsReconciliationCursor` singleton (PK `singletonKey`) tracks:
`nextOffset`, `bootstrapCompleted`, `bootstrapStartedAt?`, `lastTransactionAt?`,
`lastTransactionIdHash?`, `lastSuccessfulRunAt?`, `lastFailedRunAt?`,
`consecutiveFailureCount`, `safeLastErrorCode?`, timestamps. It contains **no**
token / raw charge id / user id / payload / response.

- **Bootstrap**: pages **forward** from the persisted `nextOffset`, advancing it
  after each page. Marks `bootstrapCompleted` on a **short page** (fewer than the
  page size returned).
- **Steady state**: re-scans recent pages from `offset 0` (new transactions
  **prepend** in `getStarTransactions`), bounded by the lookback window.
- Progress is persisted **after each page**. The offset is **never reset on an
  API error** — a failure increments `consecutiveFailureCount` and records
  `safeLastErrorCode`, leaving the cursor where it was so the next run resumes.

### Recovery eligibility (all must hold)

A star transaction is recoverable **only** when:

- `source.type = user` and `transaction_type = invoice_payment`,
- `invoice_payload` starts with `zedbot:sub:`,
- `subscription_period = 2592000`,
- `amount > 0`,
- the user matches the local subscription's user,
- the amount matches the **frozen contract** (never a mutated live price),
- the payload resolves to a local subscription,
- the tx date is **not before enrollment** beyond a **10-minute clock-skew
  slack**,
- and **no local charge exists yet** for that charge id.

Each recoverable transaction enqueues a bot-consumed `SETTLE_RECOVERED_CHARGE`
job — recovery **never fabricates a subscription**, only settles a charge that
Telegram genuinely made.

---

## Recovery evidence — LIVE vs. derived, and convergence

Two evidence enums (additive migration
`20260719140000_stars_subscription_recovery_operations`) record **how** each
charge and its period end were established:

| Enum | Values | Meaning |
| --- | --- | --- |
| `TelegramStarsChargeEvidenceSource` | `LIVE_SUCCESSFUL_PAYMENT` (default) / `STAR_TRANSACTION_RECOVERY` | Was the charge seen live, or recovered from `getStarTransactions`? |
| `TelegramStarsPeriodEndSource` | `LIVE_EXACT` (default) / `RECOVERED_DERIVED` | Is the period end Telegram's exact `subscription_expiration_date`, or derived? |

A **recovered** charge is `STAR_TRANSACTION_RECOVERY` + `RECOVERED_DERIVED`, with
period end computed as `txDate + period`. If the live `successful_payment` update
for that same charge later arrives, it **upgrades** `periodEndSource` →
`LIVE_EXACT` (the exact expiry) **without** a second charge / Payment / Order /
renewal. This convergence is the core safety property: live and recovery paths
resolve to **one** settled charge, never a double renewal.

New charge columns: `evidenceSource`, `telegramTransactionAt?`, `periodEndSource`,
`recoveredAt?`. The migration backfills all existing rows to the safe defaults
(`LIVE_SUCCESSFUL_PAYMENT` / `LIVE_EXACT`) and **fabricates no** billing,
subscription, or PAST_DUE state.

---

## PAST_DUE detection & recovery

PAST_DUE is raised two ways: the live `failed` subscription update (Part B), and
the worker's `EXPIRATIONS` processor (below) when a subscription is past
`period + grace` with **no newer charge and no live `active` update superseding
it**. PAST_DUE:

- creates **no** Payment / Order,
- emits **one deduped** `STARS_SUBSCRIPTION_PAST_DUE` notification,
- is **recoverable**: if a delayed charge later settles, the subscription
  transitions `PAST_DUE → ACTIVE` (and a stale PAST_DUE notification is cancelled
  by the notification revalidation — see `-operations.md`).

---

## Refund retries & reconciliation

- **Refund retries**: the worker `REFUNDS` processor selects `REFUND_PENDING`
  charges with remaining retry capacity → a bot-consumed `RETRY_REFUND` job.
  Attempts are bounded by `telegram_stars_subscription_refund_max_attempts`
  (spaced by `telegram_stars_subscription_refund_retry_minutes`, default 30).
  When retries are **exhausted**, the subscription is marked `REQUIRES_ACTION` —
  **never** a `WalletTransaction`.
- **Refund reconciliation**: confirms **only outgoing** star transactions that
  match an existing `REFUND_PENDING` charge (same user / amount). Unknown outgoing
  transactions are ignored — recovery never invents a refund.

## Fulfillment reconciliation (stuck charges)

The `EXPIRATIONS` processor also selects stuck charges → a bot-consumed
`RECONCILE_CHARGE` job, so a charge whose fulfillment outcome is uncertain is
re-driven through the existing read-after-write reconciliation (completes on proof
of renewal, or refunds on proof of non-application) — never both.

---

## Producer / consumer split

The worker **owns** discovery and scheduling but **produces** money-touching jobs
onto the bot-consumed `stars-subscription-execute` queue; the bot consumer runs
them with grammy's `Api` + the **existing** settlement/refund services. One
implementation, idempotent on the unique `telegramPaymentChargeId`. This mirrors
the wallet auto-renewal producer/consumer split (`wallet-auto-renewal.md`).

| Job (on `stars-subscription-execute`) | Producer | Consumer runs |
| --- | --- | --- |
| `SETTLE_RECOVERED_CHARGE` | worker recovery | `settleTelegramStarsSubscriptionCharge` |
| `RETRY_REFUND` | worker `REFUNDS` | `refundStarsSubscriptionCharge` |
| `RECONCILE_CHARGE` | worker `EXPIRATIONS` | reconcile the stuck charge |

Consumer: `apps/bot/src/services/stars-subscription-consumer.ts`, registered in
`apps/bot/src/index.ts`. Because settlement/refund are idempotent on the unique
charge id, a duplicate delivery, retry or restart converges — never a double
charge or double refund.

---

## Worker engine (Parts I/J/K/L/M/W/Y)

`apps/worker/src/stars-subscription/engine.ts` registers the existing
`stars-subscription` queue + **4 processors** with the existing scheduler ids and
reconcile lock, gated by the master switch (removes all schedulers when disabled):

| Processor | Does |
| --- | --- |
| `RECONCILE_STARS_SUBSCRIPTION_TRANSACTIONS` | drives the cursor + recovery (above) + refund reconciliation |
| `EXPIRATIONS` | PAST_DUE detection (period + grace, no newer charge, no live `active` superseding); stuck-charge selection → `RECONCILE_CHARGE` |
| `REFUNDS` | select `REFUND_PENDING` with retry capacity → `RETRY_REFUND`; exhausted → subscription `REQUIRES_ACTION` |
| `CLEANUP_STARS_SUBSCRIPTION_CHARGES` | delete only **terminal** `FAILED` / `IGNORED` charges past retention with **no** Payment / Order |

### Heartbeat / health

The engine's `getStatusFields` is merged into the notification worker status
snapshot (`zedbot:notif:worker-status`), populating:
`starsSubscriptionsEnabled`, `lastStarsSubscriptionReconcileAt`, `active`,
`chargesProcessed`, `chargesRefunded`, `pastDue`, `requiresAction`, `failures`,
plus optional `lastStarsTransactionOffset`, `refundPending`,
`reconciliationRequired`, `cursorStale`. See `system-health.md`.

---

## Settings (Part J — code-defaulted, bounded, not seeded)

Tuning needs **no migration**. Existing Phase 2 keys (grace / reconcile / lookback
/ refund-max-attempts / retention / consent-version) plus **new**:

| Key | Default |
| --- | --- |
| `telegram_stars_subscription_max_pages_per_run` | 10 |
| `telegram_stars_subscription_transaction_page_size` | 100 |
| `telegram_stars_subscription_refund_retry_minutes` | 30 |
| `telegram_stars_subscription_cursor_stale_minutes` | 120 |

---

## Cleanup & retention

`CLEANUP_STARS_SUBSCRIPTION_CHARGES` deletes **only** terminal `FAILED` / `IGNORED`
charges older than the retention window that carry **no** Payment / Order. Active,
completed, refund-pending, refunded or reconciliation-required charges are never
cleaned. Retention preserves the financial history; cleanup only removes dead
rows that never touched money.

---

## Rollback

Disabling the master switch `telegram_stars_subscriptions_enabled` is **always
allowed** and is the rollback lever:

- the worker engine **removes all schedulers** (reconcile / expirations / refunds
  / cleanup),
- in-flight `stars-subscription-execute` jobs become dormant no-ops,
- **history is preserved** — subscriptions, charges, the cursor and notifications
  stay in place; nothing is deleted or refunded by disabling.

Re-enabling resumes from the persisted cursor (steady-state re-scan bounded by
lookback) with no re-settlement of already-settled charges.

---

## Known limitations (stated honestly)

- Durable notifications **created by the bot** rely on the worker's maintenance
  reconciler to deliver them (a small delay), because the bot does not hold the
  delivery queue.
- The admin dashboard implements the **core** subpages (counts, manual reconcile,
  product list, financial report, worker/queue health) rather than every listed
  subpage.
- The `Update.subscription` compat shim should be removed once `@grammyjs/types`
  exposes Bot API 10.2 natively.

---

## Tests

`apps/bot/tests/stars-subscription-recovery.test.ts` (real Postgres, mocked worker
Telegram client) covers recovery / cursor / updates / refunded / PAST_DUE /
refund-retry / reconcile-selection / cleanup / report. The existing
`stars-subscription.test.ts` + `stars-subscription-protocol.test.ts` cover
enrollment / settlement / refund / exclusivity. Full bot suite green (1423
passed).
