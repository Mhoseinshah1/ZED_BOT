# Admin-controlled unified purchase menu

An OWNER-controlled setting that changes only the **presentation** of the user
main-menu purchase entry. It never adds a checkout engine, catalog, pricing
resolver, payment flow, Order type or Product type — the two existing purchase
flows (VPN subscription + Other Products) are untouched. **No migration.**

Design + tests: `apps/bot/tests/purchase-menu-combined.test.ts` and
`apps/bot/tests/purchase-navigation-escape.test.ts`.

## The two layouts

The layout is selected by one boolean Setting,
`user_combined_purchase_menu_enabled` (default `false`). Missing / invalid /
falsy → SPLIT, so existing **and** fresh installations keep the two separate
purchase buttons with no migration.

### SPLIT mode (default)

The historical layout, unchanged:

| Row | Actions |
| --- | --- |
| 1 | `BUY_SUBSCRIPTION` · `RENEW_SERVICE` |
| 2 | `MY_SERVICES` · `WALLET` |
| 3 | `OTHER_PRODUCTS` · `MY_ORDERS` |
| 4 | `PRICING` |
| … | then the optional rows: `FREE_TRIAL`, `REFERRAL`, `REPRESENTATIVE`, `SUPPORT`, `ADMIN_PANEL` |

### COMBINED mode

The two separate purchase buttons are replaced by ONE «خرید محصولات 🛒»
(`PURCHASE_HUB`) that opens a purchase hub:

| Row | Actions |
| --- | --- |
| 1 | `PURCHASE_HUB` · `RENEW_SERVICE` |
| 2 | `MY_SERVICES` · `WALLET` |
| 3 | `MY_ORDERS` · `PRICING` |
| … | then the SAME optional rows in the SAME order: `FREE_TRIAL`, `REFERRAL`, `REPRESENTATIVE`, `SUPPORT`, `ADMIN_PANEL` |

Invariants (locked by tests): `BUY_SUBSCRIPTION` and `OTHER_PRODUCTS` are not
rendered in combined mode; `PURCHASE_HUB` is not rendered in split mode;
`MY_ORDERS`, `PRICING` and every unrelated action keep their callbacks;
feature-gated rows keep their visibility rules; `ADMIN_PANEL` stays viewer-aware;
no empty row; no duplicate action. **Both Inline and Reply keyboard modes render
the identical layout** — they consume the ONE shared definition
(`apps/bot/src/keyboards/user-menu-definition.ts`), so they can never drift.

## The purchase hub

`apps/bot/src/handlers/user-purchase-hub/purchase-hub.handler.ts` →
`renderPurchaseHub(ctx)`:

```
🛒 خرید محصولات

نوع محصول موردنظر خود را انتخاب کنید.
```

Keyboard:

| Button | Callback | Opens |
| --- | --- | --- |
| «خرید اشتراک 🔐» (reuses `buy_subscription`) | `CB.USER_BUY` | the existing VPN subscription flow |
| «محصولات دیگر 🛍» (reuses `other_products`) | `CB.USER_OTHER_PRODUCTS` | the existing Other Products flow |
| «بازگشت به منوی اصلی» | `CB.USER_MENU` | the main menu |

The two option buttons **reuse the existing editable labels**
(`buy_subscription`, `other_products`) so an operator edit applies here too; the
only new editable main-menu label is `purchase_hub`. The intro is the editable
`purchase_hub_intro` MessageTemplate (create-if-missing; operator edits are
preserved by the seed). The title is a static constant so a text edit can never
break the page; the intro is bounded at render time to stay within Telegram's
message limit (see [Text and message safety](#text-and-message-safety)).

### Hub state contract (read-only)

Opening the hub is read-only. It calls the authoritative
`clearCheckoutState(ctx)` so a stale **discount / receipt / wallet-top-up /
renewal-discount / extra-volume-discount / extra-time-discount** input flow can
never remain armed behind the hub. Opening the hub creates **no** CheckoutSession,
Payment, Order, WalletTransaction, Service, stock reservation,
RepresentativePurchase or ReferralCommission. Selecting one of the two choices
then enters the existing flow, which produces the same eventual purchase records
as the split layout.

## Admin toggle

Location: «تنظیمات عمومی ⚙️ → نوع نمایش منوها». The overview shows the current
layout —

```
چیدمان خرید منوی کاربر:
جداگانه          ← split
یکپارچه          ← combined
```

— plus a «تنظیم چیدمان خرید 🛒» button. The layout page shows the current status
(«دکمه‌های خرید جدا هستند» / «دکمه‌های خرید در یک دکمه ادغام شده‌اند») and a single
toggle: «فعال‌کردن منوی خرید یکپارچه ✅» when split, «بازگرداندن دکمه‌های جداگانه ↩️»
when combined. A confirmation page follows before any change.

Callbacks (all ≤ 64 bytes): `admin:menu_buy` (view),
`admin:menu_buy:ask:<code>` (confirm), `admin:menu_buy:set:<code>` (commit),
where `<code>` is the OWNER-observed layout (`0` = split, `1` = combined).

### Authorization + audit

- **All active admins** may VIEW the current layout.
- **Only the live OWNER** may mutate it — `requireOwner` re-checks
  `ctx.admin.role === "OWNER"` on both the confirm (`ask`) and commit (`set`)
  callbacks; the keyboard being hidden is never trusted. A regular admin gets a
  safe OWNER-only toast and no state changes.
- The observed code makes a **stale** confirmation detectable, and the mutation
  is an **atomic compare-and-set** against that observed value, so two concurrent
  OWNER confirmations can never double-toggle — the loser converges to an
  idempotent "state moved on" re-render. No state changes before confirmation.
- One privacy-safe audit event is written on every change:
  `user_menu.purchase_layout_changed`, carrying **only** the previous layout,
  next layout, actor role and timestamp — never a Telegram id, user id, label,
  callback payload, raw error, or Product/payment information.

## Immediate, migration-free rollout

After the OWNER changes the setting, the settings cache is cleared, so the next
`/menu` render, the next `user:menu` callback and the next admin→user-menu return
all use the new layout; Reply mode sends the updated persistent keyboard on the
next menu render. No bot restart, deployment or user/session migration is
required. Old Telegram messages are not rewritten globally; the admin result
states this: «چیدمان جدید با بازکردن دوباره منوی اصلی برای کاربران نمایش داده
می‌شود.»

## Compatibility with old keyboards

The setting controls menu **rendering** only; it never authorizes or disables a
business flow. Both callbacks and both stale reply-label paths keep working
across layout changes:

- **Old inline keyboards** — `CB.USER_BUY` always opens the VPN flow and
  `CB.USER_OTHER_PRODUCTS` always opens the Other Products flow, even in combined
  mode; `CB.USER_PURCHASE_HUB` always opens the hub, even in split mode
  (`purchaseHubHandler` is mounted before the placeholder handler).
- **Stale reply keyboards** — the reply-text resolver
  (`resolveMainMenuAction`) is deliberately **layout-independent for the three
  purchase actions**: `BUY_SUBSCRIPTION`, `OTHER_PRODUCTS` and `PURCHASE_HUB` all
  resolve regardless of which layout currently renders them. So after the OWNER
  flips the setting, a still-visible old label routes to its flow. The resolver
  uses the **current edited labels**; a superseded pre-edit label no longer
  routes; duplicate labels fail closed to no-match. **Disabled feature-gated
  actions are never made generally resolvable** — only these three purchase
  actions are layout-independent. `purchase_hub` participates in the per-menu
  duplicate-label edit-time guard (`MAIN_MENU_BUTTON_KEYS`).

## Pre-flow reply-keyboard escape (§13)

PR #127 added a narrow pre-flow Pricing escape router; it is generalized here
into a **purchase-navigation** escape router
(`purchaseNavigationEscapeRouter`; `pricingReplyEscapeRouter` remains an alias).
Mounted in `app.ts` **before** the flow dispatcher, it may interrupt the six
shared interruptible checkout/payment INPUT flows **only** when the current Reply
Keyboard text resolves to one of `PRICING`, `PURCHASE_HUB`, `BUY_SUBSCRIPTION`
or `OTHER_PRODUCTS`, then dispatches through the authoritative
`openMainMenuSection(ctx, action)` (each target handler clears checkout state).
The access gate runs **before** any state is cleared. It only acts in REPLY mode;
commands keep priority; arbitrary text and unrelated menu labels reach the active
flow; support, representative-application, customer-input-form and admin flows
are never interrupted; INLINE-mode plain text is not routed.

## Business-flow isolation

The hub buttons call the existing entry points `startBuyFlow(ctx)` and
`openOtherProductsSection(ctx)`. Nothing in the pricing / visibility / panel /
CheckoutDraft / discount / wallet / card-to-card / gateway / Stars / stock /
representative / referral / provisioning / fulfillment path is changed. The
combined layout produces the **same eventual purchase records** as the split
layout — it changes which button the user presses, not what the button does.

## Text and message safety

- New editable ButtonText: `purchase_hub` (default «خرید محصولات 🛒»). It
  participates in the editable-button listing, duplicate-label validation,
  reset-to-default, reply-text resolution and the menu-integrity tests.
- New create-if-missing MessageTemplate: `purchase_hub_intro` (default «نوع
  محصول موردنظر خود را انتخاب کنید.»).
- The hub title is a static constant; the editable intro is bounded at render
  time (`boundPlainText`, budget 3900) so no operator edit can push the page past
  the sink limit. Operator edits stay stored verbatim; only the rendered use is
  bounded. Every callback stays ≤ 64 bytes.

## Setting contract

`apps/bot/src/services/purchase-menu-layout.service.ts`:

- `isCombinedPurchaseMenuEnabled(): Promise<boolean>` — default `false`, cached
  via the shared 30s settings cache.
- `compareAndSetCombinedPurchaseMenuEnabled(expected, next): Promise<boolean>` —
  atomic compare-and-set for the OWNER confirmation (delegates to the shared
  `compareAndSetBooleanSetting`; refreshes the cache on success).
- `setCombinedPurchaseMenuEnabled(enabled)` / `currentPurchaseMenuLayout()`.

The key constant + the layout/audit vocabulary live in the shared contract
`packages/shared/src/purchase-menu.ts`
(`USER_COMBINED_PURCHASE_MENU_ENABLED_KEY`, `PurchaseMenuLayout`,
`purchaseLayoutCode`, `parsePurchaseLayoutExpectedCombined`,
`USER_MENU_PURCHASE_LAYOUT_CHANGED_EVENT`). It uses the existing `Setting` table;
no migration.

## Limitations

- The layout is a global bot-wide setting, not per-user.
- Old Telegram messages are not rewritten in place; users see the new layout the
  next time they open the main menu.
- Only the three purchase actions are layout-independent for reply-text
  compatibility; disabled feature-gated actions remain non-resolvable when hidden.
