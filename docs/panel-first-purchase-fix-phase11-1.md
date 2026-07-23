# ZED_BOT panel-first purchase fix (Phase 11.1)

## Why the fake "service type" step was removed

The purchase flow used to open with a hardcoded «نوع سرویس را انتخاب کنید:»
screen (مولتی لوکیشن / تک لوکیشن اختصاصی / تست / همه سرویس‌ها). Those
options were baked into the bot rather than coming from the operator's
data. Real panels are the source of service selection: the operator's
configured Marzban/XUI panels drive the first choice, and categories/plans
are always scoped to the chosen panel. Those location names may still exist
— but only as real categories/products the operator created manually;
nothing is hardcoded and **no default categories/products/service types are
ever created**.

## New user purchase flow

«خرید اشتراک 🔐» (`user:buy`) loads panels with `status = ACTIVE` and
`isVisible = true` (ordered by `displayOrder`, `createdAt`):

- **No panel** → «در حال حاضر پنلی برای خرید فعال نیست.» + «بازگشت به منو».
- **Exactly one panel** → panel selection is skipped; its categories show
  immediately (back button goes to the main menu).
- **Multiple panels** → «از کدام پنل می‌خواهید خرید کنید؟» with one button
  per panel (`user:buy:panel:<panelSid>`); category screens then offer
  «بازگشت به انتخاب پنل».

Then «دسته‌بندی مورد نظر را انتخاب کنید.» → «پلن مورد نظر را انتخاب کنید.»
(`user:buy:cat:<panelSid>:<catSid>`,
`user:buy:prod:<panelSid>:<catSid>:<prodSid>`) → the unchanged Phase 6
pre-invoice (discount, continue; the CheckoutSession is still the first and
only write). Empty states: «برای این پنل دسته‌بندی فعالی وجود ندارد.» /
«پلنی برای این دسته‌بندی موجود نیست.» with the appropriate back buttons.

Legacy callbacks from old keyboards (`user:buy:loc:*`,
`user:buy:cat:<M|D|T|A>:*`, `user:buy:p:<M|D|T|A>:*`) answer «این مرحله حذف
شده است. لطفاً دوباره خرید اشتراک را انتخاب کنید.» and redirect into the
new flow.

## Category/product filtering

Categories shown for a panel are exactly those with **at least one**
product matching: `type = SERVICE_PRODUCT`, `isActive = true`,
`panelId = selected panel`, `category.isActive = true`, panel ACTIVE +
visible, and `displayGroups` allowing the user's group (missing/invalid →
group F only, unchanged safe default). Products are ordered by category
order, `displayOrder`, price, `createdAt`. Categories/products of other
panels are never shown, and empty categories never appear.

Every callback re-resolves the short ids and cross-checks
`product.panelId === selected panel`, `product.categoryId` matches the
selected category, and full visibility — session state and stale buttons
are never trusted (re-checked again at continue-click, as before).

## Checkout / provisioning unchanged

The pre-invoice, discount validation, CheckoutSession creation, payment
methods, receipt review and provisioning are untouched. The checkout
snapshot already carried `panelId`/`panelName`/`panelType`/`categoryId`/
`categoryName`/product details/`serviceLocation`, and since the product is
validated to belong to the selected panel, Phase 9 provisioning keeps
working from `product.panelId` + snapshots. The session draft now stores
the selected `panelId` (the old location code is gone); Phase 6.1 cleanup
behavior is unchanged.

## Admin product creation (panel-first)

Adding a SERVICE_PRODUCT now goes: **real panel → real category → details**
(name → groups → location *metadata* → volume → duration → price → reset
cycle → invoice → position → confirm). No "service type" question exists.
With no panels: «ابتدا باید از بخش مدیریت پنل‌ها یک پنل اضافه کنید.» +
«رفتن به مدیریت پنل‌ها»/«بازگشت». The Phase 7.1 rule is untouched: with no
active category the wizard stops with «ابتدا باید از بخش مدیریت
دسته‌بندی‌ها یک دسته‌بندی بسازید.» and nothing is auto-created.
`Product.panelId`/`categoryId` are exactly the selected ones. The
OTHER_PRODUCT wizard is unchanged (it never had the fake step and needs no
panel).

## Intentionally NOT changed

Payment/receipt/provisioning logic, online gateways, Telegram Stars,
renewal/extra volume/extra time/service actions, seed data (still creates
no categories/products/panels).

## Authoritative user catalog (feat/public-pricing-catalog)

`loadUserRetailCatalog(user)` (`apps/bot/src/services/catalog.service.ts`) is the
single authoritative loader for the user-facing retail tree — a panel-first
`SERVICE` hierarchy plus a flat `OTHER_PRODUCT` grouping — assembled in two
`findMany` calls (no N+1). Every returned Product passes the ONE predicate
`isProductVisible`; a Panel or Category with zero purchasable products is
dropped; group filtering precedes counts / minimum-price / pagination. As part of
this, the buy-list helpers `visibleServiceProducts` / `visibleOtherProducts` were
tightened to apply the same `isProductVisible` predicate (previously only the
group filter), so a Product that would be rejected on click (unready panel /
invalid XUI inbound) never appears in the list either. This is a strict superset
of the previous filter and does not regress the panel-first buy flow. See
`docs/public-pricing-catalog.md`.
