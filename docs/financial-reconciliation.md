# Financial reconciliation

The persistent review queue for **duplicate successful payments**: a
provider collected real money but another `Payment` already owned the
checkout's settlement. Policy for this phase is FINANCIAL_REVIEW — no
automatic refund, no automatic wallet credit; the duplicate is filed
visibly and financial admins decide (see
[cross-provider-checkout-settlement.md](cross-provider-checkout-settlement.md)
for the settlement mechanics and the policy rationale).

Code: `apps/bot/src/services/financial-reconciliation.service.ts`.
Schema: `FinancialReconciliationCase` in
`packages/database/prisma/schema.prisma`. Migration:
`packages/database/prisma/migrations/20260715062734_atomic_checkout_settlement/migration.sql`.

## The case model

One `FinancialReconciliationCase` row per duplicate successful payment:

| Field | Meaning |
| --- | --- |
| `type` | `DUPLICATE_CHECKOUT_PAYMENT` (the only type today) |
| `status` | `OPEN` / `IN_REVIEW` / `RESOLVED` |
| `checkoutSessionId` | The checkout both payments targeted |
| `primaryPaymentId` | The payment that owns the settlement — null only when the checkout was settled before ownership tracking existed |
| `duplicatePaymentId` (**unique**) | The losing payment. The unique key makes filing idempotent: sweeps, button mashes and crash retries all converge on the same case (a racing filer's P2002 resolves to the winner) |
| `userId`, `expectedAmountToman` | Who paid and how much the checkout was worth |
| `safeReason` | Short SAFE English marker (≤ 200 chars) — never provider payloads, signatures or credentials |
| `resolvedAt`, `resolvedByAdminId` | Filled when a human closes the case |

Filing (`recordDuplicateSuccess`) is one atomic transaction: the payment's
`settlementStatus` CAS UNSETTLED → `DUPLICATE_SUCCESS_REVIEW` (+
`settlementReason`) and the case creation commit together.
`Payment.status` and `providerStatus` are never touched — the external
charge stays truthfully recorded.

## Lifecycle

```
OPEN ──(admin picks it up)──▶ IN_REVIEW ──(refund / manual credit / keep)──▶ RESOLVED
```

Only **OPEN** is machine-written today — `recordDuplicateSuccess` creates
cases as OPEN and nothing in code moves them further; `IN_REVIEW` and
`RESOLVED` exist in the enum (with `resolvedAt` / `resolvedByAdminId`
columns ready) for the human workflow. Persian status labels
(`reconciliationStatusLabel`): OPEN = «نیازمند بررسی», IN_REVIEW =
«در حال بررسی», RESOLVED = «بررسی‌شده».

## Admin queue

پنل ادمین → «مالی 💎» → «تطبیق مالی ⚖️» → «پرداخت‌های موفق تکراری»
(`financial-reconciliation.handler.ts`, routes `admin:fin:recon`,
`admin:fin:recon:dup:<page>`, `admin:fin:recon:v:<sid>`):

- **OWNER-only, on every route** — the strongest financial role available
  today (RBAC centralization is a separate task). Active non-OWNER admins
  get a safe toast («دسترسی به این بخش فقط برای مالک مجموعه فعال است.»)
  and never see case data.
- **Read-only** — the pages display cases only; there are deliberately no
  resolve/refund buttons, because no audited refund workflow exists yet.
  Resolving money (provider refund, manual wallet credit) happens through
  existing, audited paths.
- List: newest-first, 5 per page (`listReconciliationCases`), one button
  per case showing its short id, duplicate provider and amount.
- Detail: by 8-char short id (`getReconciliationCaseByShortId` — prefix
  match, ambiguity fails safe), showing user Telegram id, checkout short
  id, primary and duplicate payments with their providers, amount, status
  label and the UTC filing time.

Case rows and pages carry short ids, providers and amounts only — never
full UUIDs, authorities, payloads, signatures or credentials.

## Notifications

Sent by `notifyDuplicateSuccessCase`, **only on the call that created the
case** (`created = true` from `recordDuplicateSuccess`), and only *after*
the case has committed — a crashed or repeated notification can never
create a second case, and a retry never re-files:

- **User** (the payer): `DUPLICATE_SUCCESS_USER_TEXT` — «پرداخت شما در
  درگاه با موفقیت ثبت شد، اما این پیش‌فاکتور قبلاً با روش دیگری پرداخت شده
  است…». On the check-status button this text *is* the button's reply, so
  the notifier is called with `skipUser: true` there.
- **Admins**: every active OWNER gets `DUPLICATE_SUCCESS_ADMIN_HEADER`
  plus safe fields only — case/checkout short ids, user Telegram id,
  primary and duplicate provider + payment short ids, amount, UTC
  timestamp.

Send failures are logged and swallowed (never thrown); the queue remains
the durable surface if a one-shot alert is lost.

## Migration and backfill (`20260715062734_atomic_checkout_settlement`)

What the migration does — and, just as important, what it never does:

- **Backfills only unambiguous rows.** Every historically APPROVED payment
  is marked locally `SETTLED`; a settled checkout gets
  `settledByPaymentId` **only when it has exactly one APPROVED payment**.
- **Ambiguous rows stay NULL.** Checkouts with several APPROVED payments —
  the pre-fix double-settle victims — deliberately get **no** winner; the
  audit queries below surface them for manual review.
- **Never deletes payments or orders. Never touches balances. Never
  provisions.** The backfill is additive column-filling only, with no
  remote calls.
- **Unique-index creation fails safely.** The backfill runs *before* the
  unique indexes (`Order.checkoutSessionId`,
  `DiscountCodeUsage.checkoutSessionId`,
  `Payment(provider, externalTransactionId)`,
  `CheckoutSession.settledByPaymentId`) are created. If genuinely
  duplicated rows exist, index creation fails and the migration rolls back
  — nothing is half-applied. Run the queries below, resolve the duplicates
  manually, then re-run the migration.

### Downgrade implications

Dropping the new columns/table (`settledByPaymentId`, `settlementStatus`,
`settledAt`, `settlementReason`, `FinancialReconciliationCase`) loses the
**ownership and review records** — you can no longer tell which payment
settled a checkout or which duplicates were filed — but **no financial
rows are lost**: every `Payment`, `Order` and `WalletTransaction` predates
these columns and is untouched by them.

## Pre/post-migration audit queries

Run against the bot database (e.g.
`docker compose exec postgres psql -U zedbot -d zedbot`). All queries are
read-only. **Pre-migration**: any hits from queries 2, 5 or 6 will make
the corresponding unique index fail — fix them first. **Post-migration**:
query 4 lists the ambiguous checkouts the backfill deliberately skipped;
query 1 lists the historical double-settles behind them.

**1. Checkouts with more than one APPROVED payment** (pre-fix
double-settle victims; their checkouts are left without an owner):

```sql
SELECT "checkoutSessionId",
       COUNT(*)         AS approved_payments,
       ARRAY_AGG("id")  AS payment_ids
FROM "Payment"
WHERE "status" = 'APPROVED'
  AND "checkoutSessionId" IS NOT NULL
GROUP BY "checkoutSessionId"
HAVING COUNT(*) > 1;
```

**2. Checkouts with more than one Order** (would block the
`Order_checkoutSessionId_key` unique index):

```sql
SELECT "checkoutSessionId",
       COUNT(*)         AS orders,
       ARRAY_AGG("id")  AS order_ids
FROM "Order"
WHERE "checkoutSessionId" IS NOT NULL
GROUP BY "checkoutSessionId"
HAVING COUNT(*) > 1;
```

**3. Wallet-charge checkouts credited more than once** (multiple CHARGE
ledger rows across the checkout's payments):

```sql
SELECT c."id"              AS checkout_id,
       COUNT(w."id")       AS charge_rows,
       ARRAY_AGG(w."id")   AS wallet_transaction_ids
FROM "CheckoutSession" c
JOIN "Payment" p            ON p."checkoutSessionId" = c."id"
JOIN "WalletTransaction" w  ON w."relatedPaymentId" = p."id"
                           AND w."type" = 'CHARGE'
WHERE c."purpose" = 'WALLET_CHARGE'
GROUP BY c."id"
HAVING COUNT(w."id") > 1;
```

**4. Ambiguous checkouts** (settled but ownerless — the backfill skipped
them; each needs a human to pick/verify the real settling payment):

```sql
SELECT "id", "status", "purpose", "finalPriceToman", "paidAt"
FROM "CheckoutSession"
WHERE "status" IN ('PAID', 'COMPLETED')
  AND "settledByPaymentId" IS NULL;
```

**5. Duplicate `(provider, externalTransactionId)` pairs** (one external
charge attached to several local payments — would block the
`Payment_provider_externalTransactionId_key` unique index):

```sql
SELECT "provider", "externalTransactionId",
       COUNT(*)         AS payments,
       ARRAY_AGG("id")  AS payment_ids
FROM "Payment"
WHERE "provider" IS NOT NULL
  AND "externalTransactionId" IS NOT NULL
GROUP BY "provider", "externalTransactionId"
HAVING COUNT(*) > 1;
```

**6. Duplicate discount consumption per checkout** (would block the
`DiscountCodeUsage_checkoutSessionId_key` unique index):

```sql
SELECT "checkoutSessionId",
       COUNT(*)         AS usages,
       ARRAY_AGG("id")  AS usage_ids
FROM "DiscountCodeUsage"
WHERE "checkoutSessionId" IS NOT NULL
GROUP BY "checkoutSessionId"
HAVING COUNT(*) > 1;
```
