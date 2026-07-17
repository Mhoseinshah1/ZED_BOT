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

## Ops invariants (backups + operational logging)

Same discipline as above, applied by the production-backup/Telegram-logging
phase. Background: [backup-architecture.md](backup-architecture.md),
[operational-logging.md](operational-logging.md).

| Constraint / guard | Invariant | Who handles the violation |
| --- | --- | --- |
| `SystemLogDelivery` `@@unique([systemLogId, logTopicId])` | At most one Telegram delivery tracker per log × topic — a re-entrant `writeSystemLog`/`writeOpsLog` can never double-deliver one event | Bot writer catches the `P2002` and reuses the winner's id; worker writer uses `createMany({ skipDuplicates })` + `findUnique` recovery. Send-side idempotency is the status CAS (`PENDING`/`FAILED`/`SENDING` → `SENDING`) plus the terminal `SENT` check — a known-successful send never repeats |
| `LogTopic.key` `@unique` | One topic row per stable key (`SYSTEM`, `PAYMENT`, …); behavior binds to keys, never titles | All writers `upsert` on `key`, so the constraint is a pure backstop |
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
