# Public Retail Pricing Catalog

The user-facing **«تعرفه‌ها»** page (`CB.USER_PRICING` = `user:pricing`). It
replaces the old placeholder with a complete, live, **user-specific retail
pricing catalog**: current retail prices read straight from active `Product`
records, grouped into an understandable Panel → Category → Product hierarchy,
with bounded pagination, rich product detail, and a direct entry into the
**existing** retail pre-invoice.

It is a **catalog and navigation** feature — read-only until the user explicitly
presses Buy. It is **not** a second checkout engine, a second pricing engine, a
discount engine, a representative-pricing replacement, an admin custom-price
system, an invoice generator, or a payment mutation.

Roadmap item 3 only (صفحه تعرفه‌ها). No support-assignment/SLA, no service
transfer, no custom service naming, no lucky wheel, no gamification, no Mini App,
no custom service builder, no new representative features.

## Purpose

- display current retail prices directly from active `Product` records;
- include both `SERVICE_PRODUCT` and `OTHER_PRODUCT` products;
- respect the current user's `UserGroup`;
- respect Product, Category and Panel visibility/readiness;
- group products into sections a user can understand;
- support deterministic, bounded pagination;
- provide product details with no operational secret;
- let the user enter the existing retail pre-invoice directly;
- preserve the user's pricing-page location when they return from the
  pre-invoice;
- stay completely read-only until checkout is explicitly started.

## Retail-only pricing contract

The **authoritative** retail price is `Product.priceToman`. The page introduces
no `ProductPrice`, no `PriceList`, no `PricingPlan`, no cached catalog price, no
second price column, no admin pricing table, and no manual JSON price config.
No database migration is required. Existing Product management remains the only
writer for retail prices.

The catalog always reads the **current** database state. Viewing the page never
freezes a price. A price becomes authoritative for a purchase only through the
existing pre-invoice / `CheckoutSession` snapshot and settlement contracts.

The page shows an explicit line (`pricing_page_disclaimer`):

> قیمت‌های این صفحه، قیمت عادی و فعلی محصولات هستند. مبلغ نهایی در
> پیش‌فاکتور نمایش داده می‌شود.

It never silently substitutes representative-tier prices, discount-code prices,
Telegram Stars conversions, referral rewards, wallet promotions, or future
campaign prices. Discount codes remain available only inside the existing retail
pre-invoice.

## Menu navigation

`PRICING` is a language-neutral `UserMainMenuAction` in the ONE shared menu
definition (`apps/bot/src/keyboards/user-menu-definition.ts`) used by both the
inline keyboard and the persistent reply keyboard. Wiring: ButtonText key
`pricing`, callback `CB.USER_PRICING`. It renders as a standalone row
immediately after `OTHER_PRODUCTS`/`MY_ORDERS` and before every feature-gated
row (free trial / referral / representative):

```
BUY_SUBSCRIPTION · RENEW_SERVICE
MY_SERVICES · WALLET
OTHER_PRODUCTS · MY_ORDERS
PRICING
(optional) FREE_TRIAL
(optional) REFERRAL
(optional) REPRESENTATIVE
SUPPORT
(optional) ADMIN_PANEL
```

Pricing is **always visible** once this feature landed — no separate rollout
switch. The reply-keyboard router resolves the current (possibly operator-edited)
Pricing label through `resolveMainMenuAction`; editable labels never authorize or
determine behaviour, and the duplicate-label guard covers the `pricing` key. The
real handler is registered **before** the placeholder handler, so old
`user:pricing` keyboards open the real page. When no products are available, the
button still opens a real empty-state page — never a placeholder, never a dead
callback.

## One authoritative user catalog

`loadUserRetailCatalog(user)` (`apps/bot/src/services/catalog.service.ts`) is the
single authoritative loader:

```ts
{
  servicePanels: [{ panel, categories: [{ category, products }] }],
  otherProductCategories: [{ category, products }],
}
```

Guarantees:

- every returned Product passes the ONE predicate `isProductVisible(product,
  user.group)` (UserGroup/displayGroups, Product active, Category active, Panel
  visibility, Panel provisioning readiness, XUI inbound validity);
- `SERVICE_PRODUCT` includes its category and panel relations; `OTHER_PRODUCT`
  includes its category;
- deterministic ordering (Panel `displayOrder`,`createdAt`; Category
  `displayOrder`,`createdAt`; Product `displayOrder`,`priceToman`,`createdAt`);
- no duplicate Product, no N+1 Panel/Category query (two `findMany` calls total);
- group filtering happens **before** counts, minimum-price calculations and
  pagination;
- invalid/unready Products never affect panel/category counts;
- a Panel or Category with zero purchasable Products is not shown.

The normal retail buy-list (`visibleServiceProducts` / `visibleOtherProducts`)
was tightened to apply the **same** `isProductVisible` predicate, so a Product
that would be rejected on click (unready panel / invalid XUI inbound) never
appears in either surface. This is a strict superset of the previous group
filter — it only removes already-unbuyable products; the existing buy flow does
not regress.

## Service and Other-Product hierarchy

Service: root → Service panels → Categories → paginated product list → product
detail → existing retail pre-invoice.

- Panel page: safe display name, purchasable Product count, minimum current
  retail price. Never the base URL, credentials, API variant, auth mode,
  provisioning snapshot, token, readiness error, or account counters. When only
  one panel is available, its categories open directly; back navigation stays
  deterministic.
- Category page: name, visible product count, minimum current retail price.
- Product list page (5/page): a bounded card per product — name, panel display
  name, category, location, volume, duration, current retail price — with a
  compact button opening the detail. `0` volume/duration → «نامحدود»,
  `allLocations` → «همه لوکیشن‌ها», `MULTI_LOCATION` → «مولتی لوکیشن»,
  `DEDICATED_LOCATION` → «تک لوکیشن اختصاصی», missing → «—». No inbound ids,
  remote usernames, panel identifiers, subscription domains, config links, or
  provisioning fields.

Other products: root → Other-product categories → paginated product list →
product detail → existing retail pre-invoice. Each product shows name, category,
price, duration when applicable, a **safe** delivery label, and whether extra
customer information will be requested:

- `MANUAL_ADMIN` → «تحویل توسط پشتیبانی»
- `STOCK_ITEM` → «تحویل خودکار پس از پرداخت»
- unknown/null → «طبق توضیحات محصول»

The page never invents a pricing-only stock rule and never discloses inventory
(no stock item count/content/labels, no encrypted values, no masked previews, no
reserved/delivered inventory, no customer-input schema internals, no fulfillment
credentials). It mirrors the existing retail Other-Product catalog and leaves
final stock claim/fulfillment to the existing checkout and fulfillment contracts.

## Product detail page

The richest pricing view. For `SERVICE_PRODUCT`: name, panel display name,
category, location, volume, duration, price, and a bounded invoice description
when present. For `OTHER_PRODUCT`: name, category, price, duration when present,
delivery type, a safe "extra info may be requested" note, and a bounded invoice
description. All operator-controlled content is HTML-escaped
(`escapeHtml`); descriptions are length-bounded so a message can never exceed
Telegram limits. Buttons: خرید این پلن/خرید این محصول · بازگشت به لیست · بازگشت
به تعرفه‌ها · منوی اصلی.

## Pagination

Deterministic bounded pagination — Panels 8, Categories 8, Products 5 — computed
in memory from the same filtered Product set shown to that user. Under/overflow
normalizes safely (clamps to a valid page); an empty page after a concurrent
Product change returns to the last valid page; there is no unbounded keyboard or
message and no one-query-per-product pattern.

## Direct checkout integration

`startRetailPreInvoice(ctx, product, origin)`
(`apps/bot/src/handlers/user-checkout/checkout.handler.ts`) is the ONE authoritative
retail pre-invoice builder, reused by both the normal retail catalog and the
pricing page. It clears incompatible previous checkout state, builds the existing
typed `CheckoutDraft` from the **current** `product.priceToman`, sets the existing
product/category/panel identifiers, mints the existing idempotency nonce, stamps
the navigation-only `origin`, and renders the existing pre-invoice. It moves no
money and creates no Payment / Order / CheckoutSession / Service / panel call.

Before starting the pre-invoice from a pricing callback the handler reloads the
current user, resolves the Product ambiguity-safely, reloads its relations,
re-verifies `isProductVisible`, verifies the requested pricing section matches
`Product.type`, rejects stale/forged callbacks, clears stale draft state, and on
failure returns to the refreshed pricing page.

## Pricing return navigation (CheckoutDraft origin)

`CheckoutDraft` carries a typed optional origin (`apps/bot/src/core/session.ts`):

```ts
type CheckoutOrigin =
  | { kind: "RETAIL_CATALOG" }
  | { kind: "PRICING_SERVICE"; panelId: string; categoryId: string; page: number }
  | { kind: "PRICING_OTHER"; categoryId: string; page: number }
  | { kind: "REPRESENTATIVE" };
```

The pre-invoice «بازگشت» button routes from the origin: a pricing-origin draft
returns to the exact product-list page; normal-retail and representative drafts
behave exactly as before; a lost session falls back safely to the pricing root or
the user menu. Origin is navigation metadata only — it never affects price,
Product eligibility, settlement or authorization, and no arbitrary callback
string is ever stored.

## Price freshness

The page is a live informational view. Rendering reads the current
`Product.priceToman`; a product click reloads the current Product; the
pre-invoice shows the latest price; checkout creation freezes the existing
immutable snapshot; settlement continues using the existing
live-validation/frozen-snapshot rules. A price is never placed inside callback
data and is never trusted from the previous message, session, callback, or user
input. If a price changes between list render and product click, the pre-invoice
simply shows the new current price — no money has moved.

## Representative separation

Representative pricing stays owned exclusively by the existing Representative
Program. The pricing page never calls `listEligibleRepresentativeProducts`,
`resolveEffectiveProductPrice`, RepresentativeTier logic, or
RepresentativeProductPrice logic. For an ACTIVE or SUSPENDED representative (and
only when the program master switch is on) the pricing surface may show a
«تعرفه نمایندگی من 🤝» button that routes to the existing
`user:representative_request` surface. For an active representative the retail CTA
is labelled «خرید عادی این پلن» so it can never be confused with representative
checkout — it always seeds a **normal retail** `CheckoutDraft` (no
`draft.representative`) priced from `Product.priceToman`.

## Stock privacy

Never disclose exact inventory. The page shows a safe delivery label only; it
never reads stock content, shows counts, or reserves stock while browsing. Stock
claim and fulfillment remain owned by the existing checkout/fulfillment contracts.

## Financial isolation

Viewing pricing pages (including product detail) creates **no** `CheckoutSession`,
`Payment`, `Order`, `WalletTransaction`, `ReferralCommission`,
`RepresentativePurchase`, `Service`, `ServiceEventLog`, or stock reservation.
Pressing Buy only seeds the existing in-session retail pre-invoice draft. All
financial and fulfillment records remain owned by the existing checkout, payment,
settlement and provisioning flows. Navigating pricing pages writes no `SystemLog`
row per tap (no noisy per-view logging).

## Text registry

Reuses the existing text system with create-if-missing seed defaults (operator
edits preserved; dynamic values escaped by the caller; no secret-shaped
variables). MessageTemplate keys: `pricing_page_intro`,
`pricing_page_disclaimer`, `pricing_page_empty_services`,
`pricing_page_empty_other`, `pricing_page_product_unavailable`. ButtonText keys:
`pricing` (reused for the menu row) plus `pricing_services`,
`pricing_other_products`, `pricing_representative`, `pricing_buy_service`,
`pricing_buy_other`, `pricing_back`. Editable labels never determine callback
routing.

## Callback contract

A shared builder/parser (`apps/bot/src/handlers/user-pricing/pricing-cb.ts`) owns
every callback shape (all ≤ 64 bytes; 8-char UUID short ids; base36 pages; never
a price, full id, Telegram id or free-form text). See the table in
`docs/navigation-map.md`. Short-id resolution is ambiguity-safe (zero → not
found, two → ambiguous, never the newest match). Old `user:pricing` callbacks
remain valid.

## Limitations (explicitly out of scope)

No admin custom service pricing, price history, scheduled/regional prices,
exchange-rate conversion, taxes, installments, downloadable PDF/image tariffs,
CSV export, public web URL, Mini App, user-driven search/sorting, favorites,
comparison basket, representative price editing, discount previews, coupon
discovery, stock counts, service transfer, custom service naming, support SLA,
lucky wheel, or gamification.
