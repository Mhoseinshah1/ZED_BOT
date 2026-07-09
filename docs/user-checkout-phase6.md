# ZED_BOT user checkout foundation (Phase 6)

Phase 6 replaces the `user:buy` and `user:other_products` placeholders with
real product browsing, a pre-invoice screen, discount-code entry, and
CheckoutSession creation.

**Core rule — no Order, no Payment, no Service.** Browsing and the
pre-invoice screen write nothing to the database. The ONLY write happens when
the user clicks «ادامه و انتخاب روش پرداخت ✅»: a `CheckoutSession`
(status `PENDING`). Even then there is no Order, no Payment, no Service, no
wallet deduction and no panel call — those arrive in later phases.

Source: `apps/bot/src/handlers/user-checkout/`,
`apps/bot/src/services/{catalog,discount,checkout}.service.ts`.

## User flows

**خرید اشتراک 🔐 (`user:buy`)** — *rewritten in Phase 11.1
(`docs/panel-first-purchase-fix-phase11-1.md`)*: purchase starts with
**panel detection**, not a fake "service type" step. No ACTIVE+visible
panel → «در حال حاضر پنلی برای خرید فعال نیست.»; exactly one panel → skip
straight to its categories; multiple panels → «از کدام پنل می‌خواهید خرید
کنید؟» panel list first. Then: category list (only categories with buyable
products **for the selected panel**) → plan list (`name | price تومان`) →
pre-invoice → optional discount code → continue. Since Phase 15 the
pre-invoice also offers «پرداخت با کیف پول 🏦» when the wallet balance
covers the amount (`docs/wallet-payment-phase15.md`).

**محصولات دیگر 🛍 (`user:other_products`)**: category list → product list →
pre-invoice (shows delivery type and, when enabled, the "information
requested after payment" notice — the info itself is NOT collected yet) →
discount → continue → same confirmation.

The pre-invoice shows product details, invoice description, the user's
wallet balance, applied discount and the final price. The selected
panel/category travel inside callback data as 8-char short ids, so browsing
is stateless and survives bot restarts; the draft (product + panel +
discount) lives in the session.

## Catalog filters

A product is browsable/purchasable when ALL hold:

- `product.isActive` and `product.category.isActive`
- `displayGroups` contains the user's group (`user.group`, default F) or
  `"ALL"` — **missing/empty/invalid `displayGroups` are visible to group F
  only** (safe default, documented per spec)
- service products: panel exists, `panel.status = ACTIVE` (MAINTENANCE and
  FAILED are not purchasable) and `panel.isVisible = true`
- service products additionally: `product.panelId` equals the **selected**
  panel (Phase 11.1) — categories/products of other panels are never shown
  (`serviceLocation`/`allLocations` remain product metadata on the
  pre-invoice, not a selection step)

Visibility is re-checked when a product callback resolves AND again at
continue-click time, so stale buttons cannot buy hidden products. Empty
results show «فعلاً محصولی برای این بخش فعال نیست.»

## Discount validation (read-only foundation)

Lookup: exact code first, then uppercase. Rules checked in order: active →
startsAt/expiresAt window → `totalUsageLimit` vs `totalUsedCount` →
`appliesTo` must be PURCHASE or BOTH → `allowedGroups` (null/empty or "ALL" =
everyone, otherwise must contain the user's group) → `perUserUsageLimit`
against existing `DiscountCodeUsage` rows. Amounts: PERCENT =
`floor(price × value / 100)`, FIXED_AMOUNT = `min(value, price)`; final price
is clamped to ≥ 0. Every failure returns a friendly Persian message.

**Validation never mutates anything**: `totalUsedCount` is not incremented
and no `DiscountCodeUsage` row is created — usage finalization happens after
successful payment in a later phase. The applied code is re-validated at
continue time; if it became invalid it is dropped with a notice and the
pre-invoice re-renders.

Schema note: the Phase 2 `DiscountCode` model has no `targetType` /
`targetUserId` fields, so the "specific user" rule from the spec is not
applicable yet (adapting to the existing schema, as instructed).

## CheckoutSession behavior

Created only on continue, using the existing Phase 2 model fields:
`userId`, `purpose = ORDER_PAYMENT`, `productId`,
`orderType = SERVICE_PURCHASE | OTHER_PRODUCT`, `status = PENDING`,
`productSnapshot` (Json), `originalPriceToman`, `discountCodeId`,
`discountAmountToman`, `finalPriceToman`, `expiresAt`.

- Expiry: now + `checkout_expiry_minutes` Setting (integer, fallback 30).
- Idempotency: before creating, all other PENDING sessions of the same
  user+product are marked CANCELLED — repeated continue clicks leave exactly
  one live pending checkout.
- The snapshot freezes: product id/type/name, invoice description, category
  id+name, panel id/name/type, location + allLocations, volume, duration,
  traffic reset cycle, required-user-info flag+prompt, delivery type, and
  the full price/discount breakdown.
- «مشاهده دوباره پیش‌فاکتور» (`user:co:view:<sid>`) renders from the stored
  snapshot; ownership is enforced (short id resolves only within the
  requesting user's sessions).

## Callbacks

`user:buy`, `user:buy:panel:<panelSid>`, `user:buy:cat:<panelSid>:<catSid>`,
`user:buy:prod:<panelSid>:<catSid>:<prodSid>` (the legacy
`user:buy:loc/cat/p:<M|D|T|A>…` callbacks answer «این مرحله حذف شده است…»
and redirect into the new flow), `user:other_products`, `user:op:cat:<sid>`,
`user:op:p:<sid>`, `user:co:discount`, `user:co:discount:clear`,
`user:co:back`, `user:co:continue`, `user:co:view:<sid>` — all short-id
(8-char UUID prefix) based.

Discount text entry uses `session.currentFlow = "checkout:discount"`; only
that flow consumes user text, `/`-commands cancel it and run normally, and
returning to the main menu clears the draft.

**State cleanup (Phase 6.1)**: a single `clearCheckoutState` helper clears
the checkout draft and the discount-entry flow whenever the user leaves the
checkout surface — `/start` (even when an access gate blocks the menu),
`/menu`, the main-menu callback (`user:menu` / `common:back`), `/admin`
(admin mode is a separate surface), unregistered `/`-commands typed during
discount entry, and re-entering the buy/other-products flows. The helper
never touches admin panel/product wizard state.

## Intentionally NOT implemented

Payment methods (card-to-card, gateways, Stars), wallet deduction, Order /
Payment / Service creation, provisioning, panel API calls, renewal flow,
user service list, required-user-info collection, DiscountCodeUsage
creation/usage counters, checkout-session cleanup worker, admin discount
management. All other user menu sections stay placeholders; admin flows are
untouched.
