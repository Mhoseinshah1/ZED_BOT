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

## Unchanged locks (all passes)

- «خرید اشتراک» → `user:buy`, panel-first subscription checkout, LOCKED.
- «محصولات دیگر» → `user:other_products`, completely separate from the
  subscription purchase, LOCKED.
- Payment/order/provisioning/stock/wallet-mutation/renewal-mutation/
  receipt-decision logic and production scripts untouched by UI fixes.

## User main menu (current, restored layout)

The 13 visible ButtonText-backed buttons in their original row arrangement
(`apps/bot/src/keyboards/user-main.keyboard.ts`); the placeholder sections
answer with their placeholder pages. `next`/`previous` ButtonText keys and
the `no_*_text` empty-state templates from the reverted pass were rolled
back with it — current empty states use the pre-Phase-39 literals.

## Admin main menu (current, Fix A layout)

Five rows: مالی 💎 · مدیریت کاربران 👤 / مدیریت محصولات/پلن‌ها ·
مدیریت پنل‌ها / محصولات دیگر / تیکت‌های پشتیبانی 🎫 · پیام همگانی 📣 /
تنظیمات عمومی ⚙️ · گزارشات / بکاپ. Receipts and the five placeholder
callbacks stay registered for old keyboards.
