# Database-enforced financial invariants

The money paths do not rely on application code being bug-free: every
"at most one" rule that would corrupt money if violated is (with one
documented exception) **enforced by a PostgreSQL unique constraint**, and
every writer that can race the constraint handles the resulting Prisma
`P2002` deliberately — either by resolving idempotently to the winner or by
refusing the write. Application-level compare-and-sets remain the first
line; the constraints are the backstop that holds even against future code
bugs.

Schema: `packages/database/prisma/schema.prisma`. Background:
[cross-provider-checkout-settlement.md](cross-provider-checkout-settlement.md),
[wallet-ledger-integrity.md](wallet-ledger-integrity.md),
[atomic-discount-consumption.md](atomic-discount-consumption.md).

## The invariants

| Constraint | Invariant | What breaks without it | Who handles the P2002 |
| --- | --- | --- | --- |
| `CheckoutSession.settledByPaymentId` `@unique` | One settlement owner per checkout; one checkout per owning payment | Two provider successes both settle one checkout: double order/credit for one purchase | Written by CAS on NULL, so P2002 effectively cannot fire; races surface as CAS count 0 → same-owner resume or `DuplicateSuccess` → reconciliation case (`settleGatewayPayment`), or abort-to-admin (`approveReceiptPayment` / `approveWalletTopup`) |
| `Order.checkoutSessionId` `@unique` (nullable) | One `Order` per checkout | Duplicate orders → double provisioning / double stats for one payment | `createOrderIdempotent` (`gateway-payment.service.ts`): re-reads the winner, verifies same checkout + user, reuses it |
| `DiscountCodeUsage.checkoutSessionId` `@unique` (nullable) | One discount consumption per checkout | A retried/raced settlement consumes the code twice, breaking `totalUsedCount` | `claimDiscountUsage` short-circuits on an existing usage and serializes claimers on the code-row lock, so the constraint is a pure backstop; if it ever fired, the surrounding settlement transaction rolls back (fail-safe) |
| `Payment` `@@unique([provider, externalTransactionId])` | One local payment per external provider transaction (provider-scoped — ids are not globally unique across providers) | A replayed/forged event re-uses another payment's settlement evidence and gets a second local payment settled from one real charge | `recordProviderSuccessFromBot` catches the P2002, logs and refuses — no SUCCESS on reused evidence. The API recorder (`recordProviderOutcome`) has no catch: the DB simply refuses the write and nothing is recorded |
| `Payment.authority` `@unique` | One payment per provider handle (Zarinpal authority / NOWPayments invoice id / Stars payload) | A callback could resolve to the wrong row, or two rows could share one provider payment | Authorities are provider-issued and written once after creation; callbacks look up via `findUnique({ authority })` — a collision would fail the write, never mis-route money |
| `Payment.idempotencyKey` `@unique` | One payment row per logical attempt: `gw:<checkoutId>:<gatewayId>` (gateway) / `wallet:<userId>:<nonce>` (wallet) | Double clicks create parallel payment rows → duplicate provider payments or double balance deduction | `loadOrCreatePaymentRow` loads (and, when safe, revives) the existing row; `executeWalletOrderPayment` returns the first settled result on replay |
| `FinancialReconciliationCase.duplicatePaymentId` `@unique` | One reconciliation case per duplicate payment | Every sweep/retry files another case; admins drown in duplicates of duplicates | `recordDuplicateSuccess`: re-reads the winning case and returns it (`created = false`) |
| **WalletTransaction — app-level guard only** | One `CHARGE` ledger row per top-up payment | A pathological re-credit would double a user's balance | **NOT DB-enforced (documented gap).** Guarded by the `findFirst({ relatedPaymentId, reason })` check inside the settlement/approval transaction, itself behind the CAS status flips and the settlement claim. A partial unique index on `(relatedPaymentId, reason)` would add defense-in-depth at the cost of a migration — see [wallet-ledger-integrity.md](wallet-ledger-integrity.md) |

## Trial-entitlement and trial-lifecycle invariants

Not money, but the same discipline: every "at most one" rule that would
corrupt trial allowances or conversions is DB-enforced or CAS-guarded.
Schema + `packages/database/prisma/migrations/20260717000000_trial_entitlements_and_lifecycle/migration.sql`;
background: [free-trial-entitlements.md](free-trial-entitlements.md),
[free-trial-lifecycle.md](free-trial-lifecycle.md),
[free-trial-campaigns.md](free-trial-campaigns.md).

| Constraint / guard | Invariant | Who handles the violation |
| --- | --- | --- |
| `FreeTrialEntitlement` CHECKs: `allowance >= 0`, `consumed >= 0`, `consumed <= allowance` (migration SQL — Prisma cannot express them) | An allowance can never be overdrawn or negative, even against future code bugs | Reservation uses conditional `UPDATE … WHERE consumed < allowance` under the per-user advisory lock, so the CHECKs are a pure backstop |
| `FreeTrialResetCampaign` CHECK: `allowance > 0` | A zero-grant campaign is invalid | Builder input validation (1..100) makes it a backstop |
| `FreeTrialClaim_userId_live_key` partial unique index (**unchanged** by this phase) | One live claim per user (`CLAIMED`/`PROVISIONING`/`ACTIVE`/`MANUAL_REVIEW`) | `insertClaim` insert-first: concurrent claims die on `P2002`, rendered as the in-progress denial |
| `FreeTrialEntitlement.idempotencyKey` `@unique` | One entitlement per logical admin/campaign operation (`trial-grant:<nonce>` / `trial-reset:<nonce>` / `trial-setrem:<nonce>` / `trial-campaign:<cid>:<uid>`) | Grant/campaign writers catch the `P2002` and converge on the existing row |
| `FreeTrialEntitlement` `@@unique([campaignId, userId])` | At most one grant per campaign per user (NULL campaignId rows exempt — Postgres treats NULLs as distinct) | Campaign batch re-reads the winner on `P2002` |
| `FreeTrialCampaignRecipient` `@@unique([campaignId, userId])` | Stable audience snapshot: one recipient row per campaign/user | `createMany({ skipDuplicates })` + re-run convergence |
| `FreeTrialClaim.allowanceReleasedAt` CAS (`… IS NULL` + status ∈ FAILED/CANCELLED) | A claim's allowance unit is released **at most once**, and only from a released claim state | `releaseClaimAllowance` — CAS losers change nothing; concurrent sweeps cannot double-release |
| `Service.convertedToPaidAt` CAS (`… IS NULL AND source = 'FREE_TRIAL'`) | Trial-to-paid conversion is marked **exactly once**; `firstPaidOrderId` records the winning order | `markTrialConversion` returns false for losers; replays/reconciliation are no-ops |

## Specialized digital-product workflow invariants

Same discipline for OTHER_PRODUCT fulfillment (specialized-workflows
phase). Schema +
`packages/database/prisma/migrations/20260717213000_specialized_other_product_workflows/migration.sql`;
background: [specialized-product-workflows.md](specialized-product-workflows.md).

| Constraint / guard | Invariant | Who handles the violation |
| --- | --- | --- |
| `OtherProductStockItem.deliveredOrderId` `@unique` (nullable; upgraded from an index by this migration) | One stock item per order AND one order per item — delivery correctness in both directions is a DB guarantee | Claims are CAS `updateMany` (`AVAILABLE → RESERVED`); a `P2002` means THIS order already claimed an item concurrently — `claimStockItem` / `reserveStockItemForOrder` re-read via `findUnique({ deliveredOrderId })` and resume the winner idempotently. A stale non-claim row (e.g. DISABLED still holding the order id) is reported as an error, never as a live reservation |
| `OtherProductStockItem` `@@unique([productId, contentFingerprint])` (fingerprint nullable — legacy rows exempt) | No duplicate inventory content per product (keyed HMAC of the normalized plaintext, detected without decryption) | `importStockItems`: a `P2002` aborts the WHOLE batch (one `$transaction createMany`, all-or-nothing) and reports the duplicate without content; `previewStockImport` pre-blocks known duplicates |
| `CheckoutCustomerInput.checkoutSessionId` `@unique` | Exactly one customer-input row per checkout (frozen schema snapshot) | `getOrCreateCheckoutInput` catches the `P2002` and re-reads the winner (owner-checked) |
| `CheckoutCustomerInput.consumedByOtherProductOrderId` `@unique` + checkout-scoped CAS (`status = SUBMITTED AND consumedBy… IS NULL`) | A submission is consumed **exactly once**, by exactly one order, and one order can never consume two submissions; submission itself never settles payment / creates orders / starts fulfillment | `consumeCheckoutInputForOrder`: CAS winner gets the payload; a repeat by the SAME order returns `alreadyConsumedByThisOrder`; a different order gets `null`. Retention sweep redacts only dead-end rows — CONSUMED rows are never redacted |
| `OtherProductOrder.orderId` `@unique` (pre-existing, now shared by the specialized engine) | One fulfillment record per paid order | `ensureSpecializedRecord` / `initManualDelivery`: create-first, on the unique collision re-read and resume the winner |
| `OtherProductOrder.fulfillmentAdminsNotifiedAt` CAS on NULL (status-scoped) | Fulfillment admins are notified **at most once** per record — shared by the ready-for-delivery notice, the awaiting-stock notice, the input-completion bridge and the legacy submit path (which stamps the field inside its own status flip) | `notifyFulfillmentAdminsOnce` / `notifyAwaitingStockAdminsOnce` / `submitUserInfo` — only the CAS winner sends; losers change nothing |
| `OtherProductOrder` status CASes (`PAID`/`STOCK_RESERVED` → `AWAITING_STOCK`, stock finalize, `WAITING_USER_INFO` → `WAITING_ADMIN_DELIVERY`, copy CAS on `customerInputEncrypted IS NULL`) | Park/deliver/copy transitions apply once; crashed passes converge on retry without re-sending content or re-copying values | `specialized-product-fulfillment.service.ts` — every transition is a status-guarded `updateMany`; repeated dispatches and the replenishment retry are no-ops on already-transitioned rows |

## Ops invariants (backups + operational logging)

Same discipline as above, applied by the production-backup/Telegram-logging
phase and the direct log-group-ID setup
(`packages/database/prisma/migrations/20260718000000_direct_log_group_id_setup/migration.sql`).
Background: [backup-architecture.md](backup-architecture.md),
[operational-logging.md](operational-logging.md),
[telegram-log-group.md](telegram-log-group.md).

| Constraint / guard | Invariant | Who handles the violation |
| --- | --- | --- |
| `SystemLogDelivery` `@@unique([systemLogId, logTopicId])` | At most one Telegram delivery tracker per log × topic — a re-entrant `writeSystemLog`/`writeOpsLog` can never double-deliver one event | Bot writer catches the `P2002` and reuses the winner's id; worker writer uses `createMany({ skipDuplicates })` + `findUnique` recovery. Send-side idempotency is the status CAS (`PENDING`/`FAILED`/`SENDING` → `SENDING`) plus the terminal `SENT` check — a known-successful send never repeats |
| `LogTopic.key` `@unique` | One topic row per stable key (`SYSTEM`, `PAYMENT`, …); behavior binds to keys, never titles | All writers `upsert` on `key`, so the constraint is a pure backstop |
| `LogGroupSetupAttempt` `@@unique([activeSlot])` (nullable) | **Only one log-group setup runs at a time.** `activeSlot = 1` while an attempt occupies the running slot (`QUEUED`/`PROVISIONING`/`TESTING`), `NULL` otherwise — so any number of `VALIDATED` previews and finished/failed/cancelled rows coexist while at most one runs | `confirmLogGroupConnection` sets `activeSlot = 1` in the same CAS `VALIDATED → QUEUED` write; a second concurrent confirm hits `P2002` and is told «یک عملیات راه‌اندازی گروه لاگ در حال انجام است…». Freed (`NULL`) on activation, cancellation, and **any** terminal failure — the worker wraps its whole post-claim body so a final-attempt throw (dead-worker lock, transient DB error, unexpected error) always runs `failAttempt`, and the bot startup **resume sweep** (`resumeStaleLogGroupSetups`) re-enqueues a running attempt stale past `STALE_PIPELINE_MINUTES`, so the slot has an automatic reaper and never strands |
| `LogGroupSetupAttempt.idempotencyKey` `@unique` | One attempt per logical setup request (minted `randomUUID` at preview) | Set once at `VALIDATED` creation; combined with the BullMQ jobId `log-group-setup-<attemptId>`, a repeated OWNER confirm reuses the same attempt + job rather than duplicating work |
| `LogGroupSetupAttempt` status CASes (`VALIDATED → QUEUED` on confirm; `QUEUED`/`PROVISIONING`/`TESTING` → `PROVISIONING` worker claim; `PROVISIONING`/`TESTING` → `ACTIVE` activation; non-terminal → `CANCELLED`) | Every transition applies once; a re-delivered/crashed job resumes from the row instead of double-provisioning, and a cancel/concurrent-activation race can never produce a partial switch | `log-group-connection.service.ts` (bot) + `log-group-setup.ts` (worker) — each transition is a status-guarded `updateMany`; a zero-match claim means "already moved" and the caller converges on the live state or aborts |
| `LogGroupSetupAttempt.topicBindings` (JSON, content invariant) | Holds **only** stable-key → Telegram message-thread-id pairs — never content, tokens or API payloads — and each binding is persisted immediately after its create, so a restart resumes and no **persisted** topic is re-created (a crash in the create→persist window can orphan one empty, never-bound topic — bounded and harmless) | Parsers on both sides keep only keys in `OPS_LOG_TOPIC_KEYS` whose value is a number; the worker persists each binding + `createdTopicCount` immediately after each `createForumTopic` |
| Activation transaction (atomic, guarded) | The active-group `Setting` rows (`log_group_chat_id` + `log_group_title`) and the `LogTopic` rows are switched **together** in one transaction, conditional on the attempt still being running — a partial activation is impossible, and a failed setup leaves the previous group untouched | `activateStagedGroup` (worker) / `activateLogGroupBindings` (bot, shared): a guarded `updateMany` to `ACTIVE` inside the tx; if it matches zero rows (cancelled/already activated) the whole tx rolls back and nothing is written |
| **BackupOperation — no extra DB unique (documented)** | At most one backup runs at a time, and one operation is executed at most once | Deliberately NOT a DB constraint: single-flight is the Redis lock `zedbot:backup:database` (SET NX PX + compare-and-delete release), the BullMQ jobId = operation id (repeated taps dedupe on the job), the bot's "one active operation" pre-check, and the `updateMany` status CAS (`QUEUED`/`RUNNING` → `RUNNING`) that turns re-delivered jobs into no-ops. A queue outage closes fresh rows as `FAILED "queue-unavailable"` so nothing can rot in `QUEUED` |

## Notes

- **Nullable uniques are deliberate.** PostgreSQL treats NULLs as
  distinct, so legacy rows (orders without checkouts, payments without an
  external transaction id, pre-claim checkouts) are unaffected by the new
  constraints.
- **P2002 handling is always inside the owning transaction or immediately
  around it**, never swallowed generically: each handler either converges
  on the already-committed winner (idempotent success) or refuses the
  specific write while leaving everything else intact.
- The migration that added the settlement-phase constraints backfills
  first and **fails safely** on pre-existing duplicates — the audit
  queries in [financial-reconciliation.md](financial-reconciliation.md)
  find and explain every row that can block it.

## Automated notifications (feat/notification-retention-engine, Phase 1)

- `AutomatedNotification.dedupeKey` is **UNIQUE**. The scan relies on this: it
  `create`s and treats a `P2002` as "already scheduled this cycle". This makes
  concurrent scans converge to exactly one row per (service, threshold, cycle).
- Status is a strict lifecycle: `SCHEDULED → SENDING → SENT`, with terminal
  branches `FAILED`(→retry)/`DEAD_LETTER`/`CANCELLED`/`SUPPRESSED`/`EXPIRED`.
  Delivery claims `SCHEDULED/READY/SENDING/FAILED → SENDING` with a
  `updateMany` compare-and-set; `count == 0` means another worker won — **at
  most one send**.
- `userId` is a hard FK (`onDelete: Cascade`). `serviceId` / `checkoutSessionId`
  / `paymentId` are **soft** references (plain strings, no FK) — a notification
  survives its source row's cleanup and never cascades a delete into business
  tables.
- `NotificationInteraction` has a UNIQUE `(notificationId, type)` — a callback
  retry records the click once (no metric inflation) and cascades on notification
  delete.
- `NotificationPreference.userId` and `ServiceNotificationPreference.serviceId`
  are UNIQUE (one row each). A `null` per-service override field means *inherit*.
- The migration `20260718120000_notification_retention_engine` is **purely
  additive** (4 CREATE TYPE, 4 CREATE TABLE, indexes, 5 FKs; no DROP/ALTER of
  existing columns) and deploys clean on a populated database.

## Checkout-payment reminders (Phase 2)

- Reuses `AutomatedNotification` with `dedupeKey` unique: abandoned =
  `checkout:<id>:abandoned:v1:<stage>` (one row per checkout per stage), payment
  retry = `payment:<id>:retry:v1` (one row per failed Payment). Concurrent scans
  + worker restarts converge to one row. `checkoutSessionId`/`paymentId` stay
  SOFT references (no FK) — notification data never cascades into financial rows.
- `CheckoutNotificationPreference.checkoutSessionId` is UNIQUE (one row per
  checkout); a soft reference (no FK). Suppression instants are stamped once and
  never hard-deleted; the suppress callback is idempotent (upsert).
- Migration `20260718175109_checkout_notification_preferences` is additive (1
  CREATE TABLE + 1 unique index; no DROP/ALTER).
- Financial authority is UNCHANGED: the reminder engine reads
  `settledByPaymentId` / `PaymentSettlementStatus` / Order / receipt /
  reconciliation state but never writes them. `settledByPaymentId` remains the
  one-settlement-owner CAS anchor; a notification handler never participates in
  settlement.

## Customer win-back (Phase 3)

- Reuses `AutomatedNotification` with `dedupeKey` unique: win-back =
  `user:<userId>:winback:<lapseCycleFingerprint>:s<stageDays>` (one row per user
  per stage per lapse cycle). `lapseCycleFingerprint` is a SHA-256 of
  `latestCompletedPaidServiceOrderId + "|" + effectiveEnd.epoch`, truncated to 16
  hex chars — so a new completed purchase or a renewal produces a NEW fingerprint
  (a new cycle) while no raw order id enters the key. Concurrent scans + worker
  restarts converge to one row.
- `CustomerRetentionPreference.userId` is UNIQUE (one row per user); a real FK to
  `User` with `onDelete: Cascade`. It holds ONLY the temporary win-back snooze
  (`winbackSnoozedUntil`); the permanent marketing opt-out stays on
  `User.marketingMessagesEnabled` (never duplicated). The snooze upsert is
  idempotent and history is never hard-deleted.
- Migration `20260718193906_customer_retention_preference` is additive (3
  `NotificationInteractionType` enum values + 1 CREATE TABLE + 1 unique index + 1
  FK; no DROP/ALTER of existing columns).
- The financial + provisioning systems are UNCHANGED: the win-back engine reads
  Order / Service / Payment / CheckoutSession / receipt / reconciliation state but
  never writes them, and never creates a payment, checkout, order or service.
  Lifecycle segments are derived on every evaluation, never persisted.
