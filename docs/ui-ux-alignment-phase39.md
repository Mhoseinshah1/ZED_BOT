# UI/UX alignment history (Phase 39 → Corrective Fix A)

## Status

The original Phase 39 "alignment pass" (simplified 7-button user menu,
hidden placeholders, trimmed admin root) was **reverted in full** at the
user's request (revert commits of `83475a3` and `e4c7e54`): the previously
approved layouts were restored — the 13-button user main menu (including
زیرمجموعه‌گیری، تست رایگان، گردونه شانس، آموزش، تعرفه‌ها، درخواست نمایندگی)
and the full admin root.

UI corrections now proceed as small, explicitly-specified fixes instead of
a blanket alignment pass:

- **Corrective Fix A** (current) — admin finance nesting (receipts moved
  off the admin root into the finance landing; placeholder buttons no
  longer rendered on the root, callbacks still answered), wallet landing
  cleanup (identity + balance + counters incl. the new pending-order
  count; four operator-editable wallet MessageTemplate keys; exact
  keyboard rows with «بازگشت به منوی اصلی»), and the direct
  «تمدید سرویس ♻️» button on the service detail page via the existing
  `user:renew:svc:<sid>` route. See `docs/bot-ui-gap-report.md`
  (before/after) and `docs/bot-ui-contract.md` (the resulting contract).
- **Corrective Fix B** (not started) — receipt-detail extra actions.
- **Fix A regression fix** (current) — the pre-Fix-A revert had made the
  six unfinished user placeholder buttons visible again; the accepted
  4-row user menu (placeholders hidden, callbacks still answered) and the
  accepted non-business texts (`no_services_text` / `no_orders_text` /
  `no_tickets_text` templates wired to their empty states, `next` /
  `previous` ButtonTexts) are restored. Fix A behavior untouched.

## Unchanged locks (all passes)

- «خرید اشتراک» → `user:buy`, panel-first subscription checkout, LOCKED.
- «محصولات دیگر» → `user:other_products`, completely separate from the
  subscription purchase, LOCKED.
- Payment/order/provisioning/stock/wallet-mutation/renewal-mutation/
  receipt-decision logic and production scripts untouched by UI fixes.

## User main menu (current, 4-row layout)

Four rows of implemented sections only — buy+renew / services+wallet /
other-products+orders / support (`user-main.keyboard.ts`), all labels
ButtonText-backed. The six placeholder callbacks keep answering via
`user-placeholders.handler.ts`. The `next`/`previous` ButtonText keys and
the three `no_*_text` empty-state templates are seeded (create-if-missing)
with code fallbacks and wired to the services / other-product-orders /
tickets empty states.

## Admin main menu (current, Fix A layout)

Five rows: مالی 💎 · مدیریت کاربران 👤 / مدیریت محصولات/پلن‌ها ·
مدیریت پنل‌ها / محصولات دیگر / تیکت‌های پشتیبانی 🎫 · پیام همگانی 📣 /
تنظیمات عمومی ⚙️ · گزارشات / بکاپ. Receipts and the five placeholder
callbacks stay registered for old keyboards.
