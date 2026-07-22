# Representative Program

A controlled **reseller-price** program. A user applies to become a
representative; the **bot OWNER** reviews the application and, on approval,
assigns a pricing **tier**. An active representative may then buy eligible
`SERVICE_PRODUCT` items at the configured reseller price **for their own
account**, through the existing checkout / payment / provisioning stack.

It is **not** a referral system, an affiliate/commission system, an MLM, a
second wallet, a manual ledger, a permission to create Services, a permission to
access other users, or a new admin role. Representative pricing is a **pricing
input**, never a settlement system.

## Distinction from Referral (§17)

Referral and Representative are fully separate:

- a representative may still have an ordinary referrer record from the past —
  it is left untouched;
- a reseller-priced order (`pricingMode === "REPRESENTATIVE"`) **never** earns a
  referral commission — the reseller price is the only benefit and it does not
  stack with affiliate credit;
- no referrer attribution is modified and no referral history is deleted.

The exclusion lives inside `creditReferralCommissionForOrder`: it reads the
order's immutable checkout snapshot and, when `pricingMode` is `REPRESENTATIVE`,
records a terminal no-commission marker (so the durable scan converges) and
returns `representative-excluded`.

## Rollout switches (§3)

Three OWNER-managed boolean settings (shared constants, atomic compare-and-set),
all default **false**:

- `representative_program_enabled` — the master switch. Hides the user menu row
  and the dashboard while off.
- `representative_applications_enabled` — gates **new** applications only; never
  deletes or cancels existing ones.
- `representative_checkout_enabled` — gates **new** reseller-priced checkout
  creation; never cancels a settled Payment / paid Order and never revokes a
  provisioned Service.

Disabling any switch is safe: stale/direct callbacks fail closed, and settled
money and provisioned Services are never touched. The main-menu «نمایندگی 🤝»
row renders only when the program master switch is on. Reach the admin console
from **تنظیمات عمومی → مدیریت نمایندگی 🤝**.

## Application lifecycle (§9, §10, §13, §25)

Statuses (`@zedbot/shared`): `DRAFT → PENDING_REVIEW → APPROVED | REJECTED |
WITHDRAWN`.

- The wizard collects full name, phone (normalized Iranian mobile), province,
  city, sales channel, expected monthly customers, optional experience and a
  motivation explanation, then previews and requires an explicit confirmation.
- Submission is **idempotent** — a Telegram replay converges via the unique
  `sourceUpdateId`, and a partial unique index enforces **at most one open
  (`DRAFT`/`PENDING_REVIEW`) application per user**, so a duplicate submit
  converges to the one open row.
- A user may withdraw their own open application (→ `WITHDRAWN`); history is
  retained. Rejected/withdrawn users may re-apply while applications are open.
- No national id / bank card / password / token / panel credential is collected.

## Representative lifecycle (§12, §20)

Statuses: `ACTIVE → SUSPENDED ↔ ACTIVE`, and `ACTIVE | SUSPENDED → TERMINATED`
(irreversible).

- **Approval** (OWNER only) is transactional and convergent: it marks the
  application `APPROVED` and creates exactly **one** `Representative`
  (`userId` is unique, so a concurrent double-approve resolves to the same row),
  assigns the selected active tier, and stamps the approving admin/time. A
  fail-soft congratulations notification carries only the tier name — no reason,
  no admin identity, no secret.
- **Rejection** (OWNER only) requires a mandatory, user-facing reason (stored,
  never logged); status-guarded so a stale button cannot overwrite a decision.
- **Suspend** blocks new reseller checkout immediately, keeps the dashboard
  read-only, does **not** block normal retail purchases and does **not** cancel
  paid Orders. **Reactivate** returns to `ACTIVE`. **Terminate** is irreversible
  (double-confirmed in the UI), blocks future reseller checkout and retains all
  history; it never deletes Services/Orders/Payments/Wallet history and never
  touches the user's normal account.
- No admin permission of any kind is granted to a representative.

## Tier & price model (§18, §19)

- A **tier** (`RepresentativeTier`) has a stable `slug` (behaviour binds to it,
  never the operator-facing name). Tiers are archived (`isActive=false`), never
  hard-deleted; **archiving is blocked while active/suspended representatives
  still use the tier** (safe blocking).
- A **product price** (`RepresentativeProductPrice`) is exactly one row per
  `(tier, product)` (unique constraint) — editing updates in place; disabling
  archives it. A price is valid only for an active representative-eligible
  `SERVICE_PRODUCT`, validated against the **current** retail price.
- Price modes: `FIXED_TOMAN` (≥ 1 and ≤ current retail — a stale fixed price
  above retail fails closed) and `PERCENT_DISCOUNT` (integer 1..95, floored,
  exact integer-Toman arithmetic — never floating point).

## Price precedence (§7)

`resolveEffectiveProductPrice({ user, product, checkoutPurpose, discountCode })`
is the single authority:

1. start from `Product.priceToman` (retail — the ceiling; a rep never pays more);
2. an ACTIVE representative's ACTIVE tier price for this **eligible**
   `SERVICE_PRODUCT` replaces the base;
3. a `DiscountCode` applies on top only in retail mode, or in representative mode
   when the code is explicitly flagged `allowRepresentativeStacking` (default
   false); otherwise it is ignored;
4. the final price is never negative; a zero final is blocked unless the checkout
   layer has a safe free-checkout contract;
5. for a non-representative the result is **byte-identical** to retail, so the
   existing retail flow is unchanged.

Reseller pricing applies **only** to eligible `SERVICE_PRODUCT` new purchases
(`Product.representativeEligible`, opt-in per product). `OTHER_PRODUCT`, wallet
top-up, renewal, extra-volume/-time, trials and admin grants stay retail.

## Product eligibility (§8)

`Product.representativeEligible` (default false) is an explicit OWNER opt-in per
product. Only an active, purchasable `SERVICE_PRODUCT` with the flag true is ever
reseller-priced; inactive/hidden products remain unavailable; panel and
provisioning eligibility are unchanged.

## Checkout reuse & immutable snapshot (§6, §15, §16)

A reseller purchase buys a Service for the representative's **own** account
(no third-party Telegram id, no ownership transfer) and reuses the existing
route end to end: pre-invoice → payment method → settlement (card-to-card /
wallet / Stars where permitted) → provisioning → refund → QR/config delivery.
Nothing is duplicated.

The checkout snapshot freezes `pricingMode: "REPRESENTATIVE"` plus the
representative/tier ids, retail/base/discount/final prices and **tier + price
fingerprints**. At the settlement boundary the price is re-resolved from live
data (the reseller-checkout switch is read **uncached**) and a stale
tier/price fingerprint **fails closed before money moves**. Once a Payment is
settled the paid Order is authoritative: a later suspension never invalidates
it, and provisioning continues under the immutable paid snapshot.

## Financial isolation (§6)

Representative pricing changes **only** the checkout's final product price. It
creates no referral commission, no affiliate credit, no extra `WalletTransaction`
type, no second wallet, no cashback/payout, no debt/credit line, no negative
balance, no manual adjustment and no off-ledger discount. Every reseller purchase
still produces exactly one `CheckoutSession` + `Payment` + `Order` +
`WalletTransaction` (for wallet) through the normal engine. The
`RepresentativePurchase` row is a **non-financial** marker linking the reused
checkout/payment/order (unique on each, for idempotency); it holds no money and
never gates settlement.

## Idempotency & concurrency (§25)

- one open application per user (partial unique index) + `sourceUpdateId` replay;
- one `Representative` per user (`userId` unique) even under a duplicate approval;
- one `RepresentativePurchase` per checkout/payment/order (unique columns);
- stale reseller pricing is rejected before settlement (fingerprint compare);
- a paid checkout stays fulfillable after a later suspension.

## Privacy & logging (§24)

Audit logs carry relational IDs (in columns), action/status codes, a coarse
value bucket and safe error codes only. The application explanation, the
rejection/suspension reason body, phone, city/address, Telegram id, full
internal ids, receipts, Service usernames, subscription/config, tokens, Panel
URLs and raw errors are **never** logged.

## Support (§21)

The dashboard's «پشتیبانی نمایندگان 🎫» routes into the existing Support Tickets
V2 system — no second support system is created.

## Limitations / out of scope (§27)

No selling to arbitrary third-party users, no subaccounts, no credit/debt/
postpaid, no separate representative wallet, no commission payouts, no MLM/
downline, no custom panel access, no bulk account creation, no CSV export, no
invoice PDFs, no tax documents, no KYC/identity uploads, no web/Mini-App
dashboard, no representative-created products, and no manual price entry during
checkout.
