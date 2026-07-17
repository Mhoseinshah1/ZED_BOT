# Specialized digital-product workflows

This phase turns OTHER_PRODUCT from "one generic manual/stock pipeline" into
**per-product specialized workflows**: Apple ID credential stock with an
email-boundary inventory format, AI accounts (ready credentials **or** a
personalized service on the customer's own account), Telegram Premium
(personalized service with a structured pre-payment form) and gift cards
(code stock or manual delivery) — while every existing GENERIC product keeps
its legacy behavior byte-for-byte.

Sources (single authorities, in dependency order):

- `packages/database/prisma/schema.prisma` + migration
  `packages/database/prisma/migrations/20260717213000_specialized_other_product_workflows/migration.sql`
- `apps/bot/src/services/other-product-profile.service.ts` — THE resolver
- `apps/bot/src/services/customer-input-schema.service.ts` — form schemas
- `apps/bot/src/services/apple-id-stock-parser.service.ts` — inventory parsers
- `apps/bot/src/services/other-product-stock-import.service.ts` — import + dedup
- `apps/bot/src/services/checkout-customer-input.service.ts` — pre-settlement input
- `apps/bot/src/services/specialized-product-fulfillment.service.ts` — the engine
- `apps/bot/src/services/other-product-stock.service.ts` — reservation API
- `packages/shared/src/crypto.ts` — `encryptSecret` / `fingerprintSecret`
- Handlers: `products/product.handler.ts` (wizard/edit),
  `user-checkout/customer-input-form.handler.ts` (`cinput:*`),
  `user-checkout/payment.handler.ts` (receipt hook),
  `admin-stock/stock.handler.ts` (import/retry),
  `admin-manual-orders/manual-orders.handler.ts` (queue/viewer)

Related docs: [navigation-map.md](navigation-map.md),
[database-invariants.md](database-invariants.md),
[payment-lifecycle.md](payment-lifecycle.md),
[other-product-wallet-fulfillment.md](other-product-wallet-fulfillment.md),
[other-product-stock-phase25.md](other-product-stock-phase25.md),
[other-products-manual-delivery-phase23.md](other-products-manual-delivery-phase23.md).

---

## Why `ProductCategory` is not enough

`ProductCategory` answers exactly one question: **where does this product
appear in the storefront?** It is an admin-named display grouping ("گیفت
کارت", "اکانت‌ها", anything) with no semantics the code may rely on —
operators rename, merge and repurpose categories freely, and one category
routinely mixes products with different fulfillment needs (a stocked gift
card next to a manually-delivered one).

Fulfillment behavior needs a **per-product, machine-readable** answer to a
different question: *how is this specific product fulfilled?* That is
`Product.otherProductKind` — an explicit admin choice made in the creation
wizard (or the detail-page selector), **never inferred from category or
product names** (the schema comment on `OtherProductKind` pins this).
Category stays presentation; kind/profile/parser drive behavior.

## Kind / profile / parser architecture

Three orthogonal columns on `Product` (all additive, migration
`20260717213000_specialized_other_product_workflows`):

| Column | Enum | Meaning |
| --- | --- | --- |
| `otherProductKind` (default `GENERIC`) | `GENERIC` · `APPLE_ID` · `AI_ACCOUNT` · `TELEGRAM_PREMIUM` · `GIFT_CARD` | What the admin sells — picks the wizard branch, the inventory format, the info form and the fulfillment behavior |
| `otherProductFulfillmentProfile` (nullable) | `MANUAL_DELIVERY` · `STOCK_CREDENTIAL` · `STOCK_CODE` · `PERSONALIZED_SERVICE` | The effective fulfillment behavior; `null` = "derive from the legacy columns" |
| `otherProductStockParser` (nullable) | `SINGLE_LINE` · `EXPLICIT_SEPARATOR` · `EMAIL_BOUNDARY` | How a bulk inventory paste is split into stock items (stock profiles only) |

Supporting columns: `collectInfoBeforeManualApproval` (default `false`),
`customerInputSchema` (Json, structured form), `completionMessageTemplate`
(optional Persian completion message, ≤ 500 chars via the `cmt` edit).

### The single resolver

`other-product-profile.service.ts` is **the one behavior authority** —
every "how is this product fulfilled?" question is answered there and
nowhere else, through three functions:

- `resolveEffectiveProfile(product)` — live `Product` row → effective
  behavior (`OtherProductFulfillmentSnapshot`, below).
- `buildFulfillmentSnapshot(product)` — the same resolution, frozen onto
  `CheckoutSession.otherProductFulfillmentSnapshot` at checkout creation.
  It **throws `FulfillmentProfileError` for a misconfigured product**, so an
  unresolvable product fails at checkout creation — *before any payment* —
  instead of selling something that cannot be fulfilled.
- `readFulfillmentSnapshot(checkout, productLoader?)` — stored snapshot →
  behavior, with the legacy fallback chain (next section).

Allowed profiles and defaults per kind (`KIND_PROFILES` /
`KIND_DEFAULT_PARSER` in the resolver):

| Kind | Allowed profiles | Default profile (null column) | Default parser | Customer info |
| --- | --- | --- | --- | --- |
| `APPLE_ID` | `STOCK_CREDENTIAL` | `STOCK_CREDENTIAL` | `EMAIL_BOUNDARY` | none (auto-delivers) |
| `AI_ACCOUNT` | `STOCK_CREDENTIAL`, `PERSONALIZED_SERVICE` | **none — the profile column is required**; a null profile throws | `SINGLE_LINE` (stock mode) | stock: none; personalized: always (default AI form) |
| `TELEGRAM_PREMIUM` | `PERSONALIZED_SERVICE` | `PERSONALIZED_SERVICE` | — | always; **collect-before-approval forced on** (the kind's defining behavior) |
| `GIFT_CARD` | `STOCK_CODE`, `MANUAL_DELIVERY` | `STOCK_CODE` | `SINGLE_LINE` | stock: none; manual: legacy `requiredUserInfoEnabled` flag |
| `GENERIC` | — (legacy derivation) | — | `SINGLE_LINE` when stock-delivering | legacy `requiredUserInfoEnabled` free-text |

Resolution rules (from `resolveEffectiveProfile`):

- `requiresCustomerInfo`: always `true` for `PERSONALIZED_SERVICE`; the
  legacy `requiredUserInfoEnabled` flag for `MANUAL_DELIVERY`; `false` for
  the stock profiles (they auto-deliver).
- `collectInfoBeforeManualApproval`: only meaningful when info is required;
  forced `true` for `TELEGRAM_PREMIUM`, otherwise the product column.
- `customerInputSchema`: the validated product column, else the kind default
  (`TELEGRAM_PREMIUM_DEFAULT_SCHEMA` / `PERSONALIZED_AI_DEFAULT_SCHEMA`),
  else `null`. GENERIC never gets a structured schema.
- A kind/profile combination outside the table throws
  `FulfillmentProfileError` — the product is not sellable until fixed.

**GENERIC is byte-for-byte legacy** (`resolveGenericProfile`): stock
delivery iff `(deliveryType = STOCK_ITEM OR stockEnabled) AND NOT
requiredUserInfoEnabled` — the exact Phase 25 auto-delivery gate — otherwise
manual delivery with the legacy free-text info step. Existing products
change nothing by the mere existence of this phase.

## Immutable checkout fulfillment snapshots

`buildFulfillmentSnapshot` runs inside `createCheckoutSession`
(`checkout.service.ts`) for every OTHER_PRODUCT checkout and freezes:

```
{ version: 1, kind, profile, stockParser, requiresCustomerInfo,
  collectInfoBeforeManualApproval, customerInputSchema, promptText,
  completionMessageTemplate }
```

onto `CheckoutSession.otherProductFulfillmentSnapshot`. **Paid orders are
fulfilled from this capture, never from the mutable live `Product` row** —
an admin editing the product mid-payment cannot change what an already-paid
buyer receives (the detail-page kind selector even warns: «⚠️ تغییر نوع فقط
بر خریدهای آینده اثر دارد.»). The engine additionally copies
`kindSnapshot` / `fulfillmentProfileSnapshot` /
`customerInputSchemaSnapshot` / `completionMessageSnapshot` onto the
`OtherProductOrder` record, so the fulfillment record is self-describing
even if the checkout or product is later archived.

### Legacy-compatibility resolver order

`readFulfillmentSnapshot` resolves one checkout's behavior in strict order:

1. **Stored snapshot wins.** A valid
   `otherProductFulfillmentSnapshot` (version 1, known kind/profile/parser,
   boolean flags) is used as-is. An invalid *embedded* `customerInputSchema`
   is dropped to `null` **without rejecting the snapshot** — a schema
   problem can never silently downgrade the fulfillment profile.
2. **Live product loader** (legacy checkouts whose snapshot column is
   null/malformed): behavior derives from the live `Product` via
   `resolveEffectiveProfile` — exactly what the pre-phase fulfillment code
   did (it always read `order.product`). A loader throw (misconfiguration)
   falls through.
3. **Last resort — `productSnapshot`-derived GENERIC**: the checkout's
   generic product snapshot (`requiredUserInfoEnabled`,
   `requiredUserInfoPromptText`, `deliveryType`) with kind `GENERIC` and
   `collectInfoBeforeManualApproval: false`. `productSnapshot` never
   captured `stockEnabled`, so only `deliveryType = STOCK_ITEM` can indicate
   stock here — acceptable for the deleted-product edge this path exists
   for.

## Pre-settlement customer input

### The trust boundary (read this first)

**Submitting the customer-information form is NEVER a financial event.**
`submitCheckoutInput` writes exactly one `CheckoutCustomerInput` row and
nothing else. It never:

- settles a payment (no `Payment`/`CheckoutSession` status change),
- creates an `Order` or `OtherProductOrder`,
- starts fulfillment,
- notifies fulfillment admins,
- consumes or reserves stock.

Collecting information before the receipt is approved exists purely to
remove a round-trip for the buyer; the money path is unchanged. Consumption
happens **exactly once, at settlement-side fulfillment**, via the CAS on
`consumedByOtherProductOrderId` (unique).

### Lifecycle

One `CheckoutCustomerInput` row per checkout (`checkoutSessionId @unique`),
frozen `schemaSnapshot` at creation:

```
COLLECTING ──submit (CAS)──► SUBMITTED ──consume (CAS, at settlement)──► CONSUMED
     │                           │
     └──────► ABANDONED ◄────────┘        (dead checkout; abandonCheckoutInput)
                  │
                  └──retention sweep──► REDACTED   (valuesEncrypted + summary cleared)
```

- **COLLECTING** — the row exists; in-progress answers live ONLY in the
  Telegram session draft (`ctx.session.temp.customerInputForm`). Nothing is
  persisted per field.
- **SUBMITTED** — the confirm button (`cinput:confirm`) re-validated every
  field server-side against the frozen `schemaSnapshot`, encrypted the
  values (`valuesEncrypted`, AES-256-GCM) and stored the masked
  `renderedSafeSummary`. The COLLECTING→SUBMITTED flip is a CAS, so a
  double-tapped confirm converges to `{ok, already:true}`.
- **CONSUMED** — an `OtherProductOrder` claimed the submission
  (`consumeCheckoutInputForOrder`): CAS on `status = SUBMITTED AND
  consumedByOtherProductOrderId IS NULL`, checkout-scoped, so consuming
  another checkout's input is impossible by construction and one order can
  never consume two submissions (the unique). CONSUMED rows are the
  fulfillment record and are **never redacted**.
- **ABANDONED** — `abandonCheckoutInput` marks a dead checkout's row
  (exported for the receipt-rejection/cancellation side; not wired to any
  caller yet — the sweep's dead-checkout clause covers the gap).
- **REDACTED** — the retention sweep (`runCheckoutInputRetentionSweep`,
  hourly loop started in `apps/bot/src/index.ts`) securely redacts dead-end
  rows older than the retention window: `ABANDONED` rows and `SUBMITTED`
  rows whose checkout ended `EXPIRED` / `CANCELLED` / `FAILED_REFUNDED`.
  Redaction clears **both** `valuesEncrypted` and `renderedSafeSummary` and
  stamps `redactedAt`.

**Retention setting:** `Setting` key `customer_input_retention_days`
(`CUSTOMER_INPUT_RETENTION_DAYS_KEY`), **default 7 days** when unset or
invalid.

### The form (`cinput:*`)

`customer-input-form.handler.ts` renders a one-field-at-a-time wizard over
the frozen schema (flow `customer_input:form`): field prompts with Persian
validation errors, `SELECT` options as buttons (**callback data carries the
option index only, never option text** — `cinput:opt:<i>`), «رد شدن ⏭» for
optional fields, «⬅️ قبلی», a review page rendered by `renderSafeSummary`
(sensitive values masked even for the buyer), and «تایید و ثبت ✅». Cancel
keeps the DB row COLLECTING; re-entry (`cinput:start:<checkout-prefix>`,
owner-scoped 12-char prefix resolution) restarts from field 0. Commands
(`/…`) abandon the flow and run normally.

Schema limits (enforced by `validateCustomerInputSchema`): ≤ 10 fields;
keys `^[a-z][a-z0-9_]{0,31}$` and unique; labels 1–100 chars; values ≤ 1000
chars (≤ 2000 for `MULTILINE_TEXT`); `SELECT` 2–10 options of ≤ 60 chars;
field types `TEXT` / `EMAIL` / `PHONE` / `TELEGRAM_USERNAME` /
`MULTILINE_TEXT` / `SELECT`; labels/options reject `<`, `>`, `${`, `{{`
(injection guard). Value normalization: usernames lose the leading `@`,
phones get Persian/Arabic digits normalized and separators stripped.

### Card-to-card sequence (the flagship flow)

For products whose frozen snapshot has `requiresCustomerInfo` **and**
`collectInfoBeforeManualApproval` (Telegram Premium always; others when the
admin turned «دریافت اطلاعات قبل از تایید رسید» on):

1. Buyer submits the receipt → `Payment PENDING_REVIEW` + `ManualReceipt`
   (**no money, no order** — unchanged Phase 8 semantics), admins get the
   receipt notification.
2. `maybeStartPreSettlementCustomerInput` opens the form **immediately**,
   in the same turn — presentation-only, wrapped in its own try/catch so a
   form failure can never break the already-registered receipt. (A legacy
   GENERIC row with the toggle on but no structured schema instead gets a
   heads-up that info will be requested after approval — the code never
   invents a schema.)
3. Buyer completes the form → row SUBMITTED (encrypted) → notice:
   «اطلاعات شما ثبت شد. انجام سفارش پس از تایید پرداخت آغاز می‌شود.»
   Nothing else happens — see the trust boundary above.
4. Admin approves the receipt → the **atomic settlement transaction**
   (payment APPROVED via CAS, checkout PAID + `settledByPaymentId` claim,
   Order PAID, discount claim) commits first, exactly as before.
5. `dispatchPaidOrderFulfillment` (post-commit, never inside the money
   transaction) routes to the specialized engine, which — **exactly once
   each, all DB-CAS-backed**:
   - creates THE `OtherProductOrder` (unique `orderId`) with the frozen
     snapshots,
   - consumes the submission (`consumedByOtherProductOrderId` CAS) and
     copies it onto the record (`customerInputEncrypted` CAS on NULL),
   - flips `WAITING_USER_INFO → WAITING_ADMIN_DELIVERY`,
   - notifies fulfillment admins (`fulfillmentAdminsNotifiedAt` CAS on
     NULL).
6. If the buyer had NOT finished the form before approval, the dispatch
   sends «تکمیل اطلاعات سفارش 📝» (`cinput:start:…`) instead; on submit the
   completion bridge (`onCustomerInputCompleted`) runs the same
   consume/copy/notify CASes. Repeats and races converge — no double
   notification, no double copy.

Wallet and online-gateway payments settle immediately, so for them the form
always runs post-settlement via the same `cinput:start` button.

## Apple ID inventory format (`EMAIL_BOUNDARY`)

Admins paste the whole inventory in one message. A line whose **entire
trimmed content is one valid email address** — or a full-line labeled form
`Email: <addr>` / `ایمیل: <addr>` (any label casing, ASCII or fullwidth
colon) — **starts a new account record**; every following line until the
next boundary belongs to that record (the boundary line stays part of the
record's content). The spec's two-account example:

```
ali.demo@icloud.com
Password: S3cure!Pass1
Birthday: 1990-01-01
Country: US

sara.demo@icloud.com
Password: An0ther!Pass2
2FA: disabled
```

parses into exactly two stock items, each carrying its full multi-line
block. Boundary rules (`parseAppleIdInventory`):

- **Embedded emails never split**: an email inside a longer sentence does
  not start a record (counted and warned about, never an error).
- **Content before the first boundary rejects the whole paste** — it cannot
  be attributed to any account.
- **Empty blocks reject**: a boundary email with no content lines after it
  (`بلاک حساب a***o@i***.com بعد از خط ایمیل هیچ محتوایی ندارد.`).
- Record-edge blank lines are trimmed; internal line order and meaningful
  internal blank lines are preserved.
- **Any error rejects the ENTIRE paste** (`ok: false, items: []`) — a
  partial or ambiguous inventory is never imported.

Limits (shared by all three parsers):

| Limit | Value |
| --- | --- |
| Total paste | `INVENTORY_TOTAL_MAX_CHARS` = 200,000 chars |
| Items per paste | `INVENTORY_MAX_ITEMS` = 500 |
| One block/line | `INVENTORY_BLOCK_MAX_CHARS` = 4,000 chars |

The other parsers: `EXPLICIT_SEPARATOR` splits on lines that are exactly
`---` (empty blocks between stray separators are skipped with a warning);
`SINGLE_LINE` is the legacy one-item-per-line split (over-long lines skipped
as invalid, duplicates deliberately kept — dedup is fingerprint-based in the
import service).

**Masked preview**: raw content never appears in previews, errors or logs.
Emails render as `a***i@i***.com` (`maskEmail`); non-email identifiers as
`abcd...wxyz` (`maskSecretEdges`). The import preview shows counts plus the
masked first/last identifiers only, and Apple-ID items get the **masked**
email as their admin-visible stock `label`.

### Import flow (preview → confirm)

`admin:stock:bulk_add:<sid>` shows parser-specific instructions. For
`EMAIL_BOUNDARY` / `EXPLICIT_SEPARATOR` products the paste routes through
`previewStockImport`: item count, masked first/last, invalid-line count,
in-batch duplicate count (informational — first occurrence kept) and
existing-inventory duplicate count (**blocking**). The preview is
deliberately **stateless** — nothing is stashed server-side and no import
token exists; the raw paste stays only in the admin's session draft
(`adminStockDraft.parserRaw`). «تایید و افزودن ✅»
(`admin:stock:imp_confirm`) re-parses and re-validates that draft from
scratch and inserts everything in **one all-or-nothing `createMany`**; a
`P2002` on `(productId, contentFingerprint)` — a concurrent import or an
item added since the preview — aborts the whole batch with the duplicate
error. `SINGLE_LINE` products keep the exact legacy Phase 27 bulk flow.
Every successful inventory addition (single add, legacy bulk, parser
import, and the manual «تکمیل سفارش‌های در انتظار 🔁» button) triggers the
awaiting-stock replenishment retry.

## Encryption and secret handling

| Data | Protection |
| --- | --- |
| Stock item content (`contentEncrypted`) | AES-256-GCM via `encryptSecret` (key: `scrypt(APP_SECRET, "zedbot.secret.v1")`, format `v1:<iv>:<tag>:<ciphertext>`); decrypted only for the buying user on delivery |
| Customer-input values (`CheckoutCustomerInput.valuesEncrypted`, `OtherProductOrder.customerInputEncrypted`) | Same AES-256-GCM; `encodeValuesEncrypted`/`decodeValuesEncrypted` are the only encode/decode path; decode throws on tampering / a rotated `APP_SECRET` and callers never log the payload |
| Duplicate detection (`contentFingerprint`) | `fingerprintSecret`: deterministic **HMAC-SHA256** with a separately-derived key (`scrypt(APP_SECRET, "zedbot.fingerprint.v1")`) over the normalized plaintext (CRLF→LF, trimmed) — duplicates are found **without decrypting, logging or exposing content**; irreversible, safe to store and index |
| Display copies | `renderedSafeSummary` / `customerInputSummary` are the ONLY plaintext renderings: every value HTML-escaped and `sensitive` fields masked with `maskSecretEdges` **before** rendering — a full password can never appear in any summary, review page, admin message or log line built from them |
| Admin decryption | On-demand only, **audited**: «مشاهده اطلاعات مشتری 🔒» (`admin:mo:cinfo:<sid>`) decrypts for a re-validated admin, shows the schema-labeled **masked** view first; «نمایش کامل 🔓» (`admin:mo:cinfo_full:<sid>`) is a second, separately-audited step. Every open writes an `AuditLog` row (`other_product_customer_input_viewed`, ids + view kind only) **before** anything is shown — a failed audit write blocks the display |

**Never logged, anywhere in this phase**: stock content (encrypted or
plain), decrypted customer values, full boundary emails, passwords, the raw
inventory paste. Logs carry ids, counts, statuses and parser names only.
List and detail pages never show values — only presence lines («اطلاعات
مشتری: ثبت شده ✅»).

## Stock reservation concurrency

`OtherProductStockItem.deliveredOrderId` is **UNIQUE** (upgraded from an
index by this migration). That one constraint makes both directions a DB
guarantee, not a code promise: a stock item reaches **at most one order**,
and an order receives **at most one item** (each order id can appear on at
most one row).

`reserveStockItemForOrder(orderId, productId, userId)` — the specialized
claim (runs alongside the untouched legacy `autoDeliverStockOrder`):

1. Idempotent resume: an item already carrying this `orderId`
   (RESERVED or DELIVERED) is returned as-is.
2. Otherwise: `findFirst` oldest AVAILABLE → CAS `updateMany`
   (`AVAILABLE → RESERVED` + claim fields), retried up to 3 times when the
   CAS loses to a concurrent order.
3. A `P2002` on `deliveredOrderId` during the race means THIS order claimed
   another item concurrently — the winner is returned idempotently. A stale
   non-claim row (e.g. DISABLED but still holding the order id) blocks the
   unique forever and is reported as an ERROR, never as a live reservation.
4. `NO_STOCK` is a **distinct outcome** so the caller can park the order.

Delivery separates reserve from send: reserve → mark the record
`STOCK_RESERVED` (transient claim window) → decrypt → send the full
HTML-escaped content to the **buying user only** → finalize in one
transaction (item `RESERVED → DELIVERED`, record `→ DELIVERED`,
Order `PAID → COMPLETED`, retried once). A failed send releases OUR claim
only (`releaseStockClaim`, scoped to `deliveredOrderId = orderId AND status
= RESERVED`) and drops the record back to `PAID` for a later retry; an
unreadable item is DISABLED and the next candidate is tried.

### `AWAITING_STOCK` — never a silent downgrade

A **paid** specialized stock order with an empty inventory is **parked as
`AWAITING_STOCK`** (`parkOrderAwaitingStock`: CAS from `PAID`/
`STOCK_RESERVED`, `awaitingStockSince` stamped once) — it is *never*
silently converted to generic manual delivery. Only the transition winner
messages the buyer («سفارش شما ثبت شد؛ موجودی در حال تکمیل است و به‌محض
شارژ ارسال می‌شود ⏳»); the admin notice («🚨 سفارش در انتظار شارژ موجودی»,
with stock-management buttons) has its own `fulfillmentAdminsNotifiedAt`
CAS, so both fire exactly once.

**Replenishment retry** (`retryAwaitingStockOrders`): re-runs the stock
branch for the product's parked paid orders **oldest first**
(`awaitingStockSince asc`, then `createdAt asc`), including any
`PAID`/`STOCK_RESERVED` stock-profile record a crashed pass left behind;
stops early when the inventory runs dry again; idempotent (a delivered
order converges without re-sending). Triggered automatically after every
successful inventory addition and manually via «تکمیل سفارش‌های در انتظار
🔁» (`admin:stock:retry:<sid>`).

## Migration and backfill

`20260717213000_specialized_other_product_workflows` is **additive** — no
existing column is altered or dropped, no data is rewritten:

- New enums (`OtherProductKind`, `OtherProductFulfillmentProfile`,
  `OtherProductStockParser`, `CheckoutCustomerInputStatus`) and two new
  `OtherProductOrderStatus` values (`AWAITING_STOCK`, `STOCK_RESERVED`).
- `Product.otherProductKind NOT NULL DEFAULT 'GENERIC'` — every legacy row
  is **backfilled to `GENERIC`** by the column default, and GENERIC's
  behavior is the exact legacy derivation, so **no existing product changes
  behavior**. Profile/parser stay `null` (= "derive from legacy columns").
- `OtherProductStockItem.contentFingerprint` is nullable: **legacy rows
  keep `null` and are invisible to dedup** — random-IV ciphertext cannot be
  fingerprinted retroactively without decrypting and rewriting the whole
  inventory (documented in the schema).
- `deliveredOrderId` index → **unique** (the claim logic always wrote at
  most one live claim per order, so existing data satisfies it).
- New nullable snapshot/input columns on `CheckoutSession` /
  `OtherProductOrder`; the new `CheckoutCustomerInput` table with its two
  uniques. Nullable uniques leave legacy rows unaffected (PostgreSQL treats
  NULLs as distinct).

## Admin runbook

### Creating a specialized product

«مدیریت محصولات/پلن‌ها» → «افزودن محصول ➕» → «محصول دیگر» → name → groups →
category → **«نوع محصول را انتخاب کنید:»** (`admin:prod:f:kind:<code>`,
codes `APPLE`/`AI`/`TGP`/`GIFT`/`GEN`):

| Choice | Sub-question | Wizard defaults applied |
| --- | --- | --- |
| اپل آیدی (`APPLE_ID`) | — | `STOCK_CREDENTIAL`, parser `EMAIL_BOUNDARY`, no info step, `deliveryType STOCK_ITEM` |
| اکانت هوش مصنوعی (`AI_ACCOUNT`) | «اکانت آماده» / «اکانت شخصی برای مشتری» (`admin:prod:f:ai:ready\|pers`) | ready → `STOCK_CREDENTIAL` + parser picker (`admin:prod:f:sp:<SL\|SEP\|EB>`); personal → `PERSONALIZED_SERVICE`, collect-before on, form preset picker (`admin:prod:f:fp:AI\|NONE` — default AI form or free text) |
| تلگرام پریمیوم (`TELEGRAM_PREMIUM`) | — | `PERSONALIZED_SERVICE`, info required, collect-before **on**, default premium form, `deliveryType MANUAL_ADMIN` |
| گیفت کارت (`GIFT_CARD`) | «کد آماده از موجودی» / «تحویل دستی توسط ادمین» (`admin:prod:f:gc:stock\|manual`) | stock → `STOCK_CODE` + `SINGLE_LINE`; manual → `MANUAL_DELIVERY` and the legacy user-info question stays |
| محصول عمومی (`GENERIC`) | — | exact legacy wizard (user-info + delivery questions) |

Every branch continues with duration → price → invoice text → (kind-
dependent legacy questions) → position → confirm → save. Specialized stock
kinds save with `stockEnabled = true`; the legacy delivery question is
skipped whenever the kind branch already fixed the delivery.

Note on the AI «بدون فرم (متن آزاد)» preset: it saves the product with a
null `customerInputSchema` column — but the resolver substitutes the
kind's default AI form for any info-collecting `AI_ACCOUNT` product whose
schema column is null (`resolveCustomerInputSchema`), so buyers still get
the structured default form, not a free-text prompt (current code
behavior, pinned here).

### Editing

Product detail (OTHER_PRODUCT) shows the kind, profile, parser,
collect-before flag and completion message, and offers:

- «نوع محصول» (`admin:prod:kind:<sid>` → `admin:prod:setkind:<sid>:<code>`)
  — applies the kind's edit-time defaults; warns «⚠️ تغییر نوع فقط بر
  خریدهای آینده اثر دارد.» (paid checkouts keep their frozen snapshot).
  GENERIC clears the specialized fields and leaves legacy settings alone.
- «فرمت موجودی» (`admin:prod:sparser` / `setsp`) — stock profiles only.
- «دریافت اطلاعات قبل از تایید رسید» toggle (`admin:prod:cba:<sid>`) — only
  for products that collect customer info at all.
- «پیام تکمیل سفارش» (`admin:prod:fe:<sid>:cmt`) — ≤ 500 chars, «-» clears.

### Inventory import

Stock product page («مدیریت موجودی استاک 🎟») → «افزودن گروهی آیتم‌ها ➕➕».
Parser-aware: EMAIL_BOUNDARY/EXPLICIT_SEPARATOR products get the
**preview** (counts + masked first/last + duplicate/invalid counts, «محتوای
کامل هرگز نمایش داده نمی‌شود.») → «تایید و افزودن ✅»
(`admin:stock:imp_confirm`) → result page with imported count and how many
parked orders the automatic retry completed. Existing-inventory duplicates
block the preview; the confirm is all-or-nothing. SINGLE_LINE products keep
the legacy bulk flow unchanged.

### Manual queue

«سفارش‌های دستی 📦»: the lists gain a conditional «در انتظار شارژ موجودی ⏳
(n)» filter button (`admin:mo:list:stock:1`) whenever paid orders are
parked; the landing shows the counter. Status labels: `AWAITING_STOCK` =
«در انتظار شارژ موجودی ⏳», `STOCK_RESERVED` = «در حال تحویل از موجودی 🎟».
The detail page adds the frozen kind/profile labels, the customer-info
presence line, and:

- «مشاهده اطلاعات مشتری 🔒» (`admin:mo:cinfo:<sid>`) — audited on-demand
  decryption, masked first; «نمایش کامل 🔓» (`admin:mo:cinfo_full:<sid>`)
  separately audited. Shown only when an encrypted structured submission
  exists.
- «تکمیل بدون متن ✅» (`admin:mo:deliver_done:<sid>`) — PERSONALIZED_SERVICE
  records only (re-checked in the service): completes the order without
  credentials, the buyer receives «انجام شد ✅» plus the frozen completion
  message. Empty delivery text is refused for every other profile.

### Awaiting-stock recovery

Stock product page → «تکمیل سفارش‌های در انتظار 🔁»
(`admin:stock:retry:<sid>`) — runs the replenishment retry on demand and
toasts completed/remaining counts. Adding inventory through any path
triggers the same retry automatically.

## User flow diagrams

### Telegram Premium — card-to-card receipt

```
buyer: checkout (snapshot frozen: TELEGRAM_PREMIUM / PERSONALIZED_SERVICE,
       collect-before-approval ON) → picks card-to-card → sends receipt
        |
        v
Payment PENDING_REVIEW  +  admins get the receipt      [NO money, NO order]
        |
        v
customer-input form opens IMMEDIATELY (cinput:*)
  telegram username -> optional phone/id -> optional note -> review -> confirm
        |
        v
CheckoutCustomerInput SUBMITTED (values encrypted)     [still NOTHING else:
  "اطلاعات شما ثبت شد. انجام سفارش پس از تایید پرداخت آغاز می‌شود."          no settlement,
        |                                               no order, no admin
        | admin approves the receipt                    fulfillment notice]
        v
atomic settlement: Payment APPROVED + Checkout PAID + Order PAID
        |
        v  dispatchPaidOrderFulfillment (post-commit)
OtherProductOrder created (snapshots frozen)
  consume submission ONCE (CAS) -> copy encrypted values ONCE (CAS)
  -> WAITING_ADMIN_DELIVERY -> notify fulfillment admins ONCE (CAS)
        |
        v  admin activates premium on the customer's account
"تکمیل بدون متن ✅" (or delivery text) -> DELIVERED + Order COMPLETED
  buyer gets "انجام شد ✅" + the frozen completion message
```

### Apple ID — purchase from stock

```
buyer pays (wallet / gateway / approved receipt) -> settlement commits
        |
        v  dispatchPaidOrderFulfillment reads the FROZEN snapshot
APPLE_ID / STOCK_CREDENTIAL  ->  specialized stock branch
        |
        v
reserve oldest AVAILABLE item (CAS; deliveredOrderId UNIQUE
                               = one item per order, one order per item)
   |
   |-- no stock? --> OtherProductOrder AWAITING_STOCK (never manual fallback)
   |                   buyer told once; admins alerted once (CAS)
   |                   admin imports inventory (EMAIL_BOUNDARY paste,
   |                   preview -> confirm) -> replenishment retry
   |                   completes parked orders oldest-first
   v
decrypt item -> send the full account block to the BUYER only (<code>, HTML-escaped)
        |
        v
finalize in ONE transaction: item DELIVERED + record DELIVERED + Order COMPLETED
        |
        v
low-stock alert check (existing Phase 28 rules)
```

## Testing pointers

Navigation integrity covers the new `cinput` namespace
(`apps/bot/tests/navigation-integrity.test.ts`). Service-level behavior is
locked by the schema constraints themselves plus the CAS patterns
documented in [database-invariants.md](database-invariants.md).
