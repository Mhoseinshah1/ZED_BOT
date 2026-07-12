# Button audit (final production audit)

Every visible button was cross-checked against its handler (see
`docs/callback-audit.md` — 0 dead buttons, 0 orphans) and against the tree
in `docs/navigation-map.md`. 203 keyboard constructions render across 242
pages; structural locks live in `navigation-integrity.test.ts` and the
per-fix suites (exact rows for the user menu, admin root, finance landing,
wallet, service detail, receipt detail, OTHER_PRODUCT landing, users
landing, product root, panel root).

## Fallbacks

Every ButtonText-backed label resolves through `getButtonText` with a
hardcoded Persian fallback — a missing/unreachable DB can never blank a
button (locked in `user-menu-placeholders.test.ts` and
`corrective-fix-a.test.ts`). Admin labels are static by design.

## Ordering / parents

- Action buttons first, pagination row next, back rows last — everywhere.
- Backs go to the DIRECT parent (list → landing → root), with
  same-filter/page context on receipts (session page), manual orders
  (filter+page), products (filter+page), panels (filter+page) and users
  (filter+page / search results). Final rows offer the section root; only
  root landings offer «بازگشت به پنل ادمین» / «بازگشت به منو».

## Icons / duplicates

One icon per concept across sections: 🧾 lists/receipts/orders, 💰/🏦
wallet, 🛍 products/services, 🎟 stock, 📦 manual orders/delivery, 🩺
health/tests, 🔎 search, ➕ add, ✏️ edit, 🚫 block, ✅ confirm/active,
⏸ inactive, 🗑 soft-delete asks. No keyboard contains duplicate callbacks
(every exact-row test would fail otherwise) and the only intentional
same-destination pairs are documented (e.g. finance landing receipts
button vs. receipt-notification deep link).

## Known cosmetic variances (accepted, documented)

- «رسیدهای تاییدنشده 💵» (Fix A/B spec spelling) vs the locked receipts
  page title «رسیدهای تایید نشده 💵» — same destination.
- Back-button wording varies by depth by design: «بازگشت» (one level),
  «بازگشت به <parent>» (named parent), «بازگشت به منوی اصلی» /
  «بازگشت به پنل ادمین» (roots). Standardizing every legacy «بازگشت به
  منو» to the long form was deliberately skipped to avoid churn in locked
  flows — listed as deferred polish.
