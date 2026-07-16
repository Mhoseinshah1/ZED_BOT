# ButtonText registry

Generated from `packages/database/src/seed-data.ts` (`INITIAL_BUTTON_TEXTS`)
— the single source of default labels. The seed creates missing rows and
refreshes stored **defaults**; operator-customized current labels are never
overwritten (see `docs/text-system.md`).

- Label limit: **1..64 characters** (`BUTTON_TEXT_MAX`, Telegram's inline
  button budget).
- Fallback rule: DB `currentText` → caller fallback → registry default → the
  bare key (never a crash). Reads cache for 30s.
- Labels are used verbatim (no variable rendering — literal braces like
  «{تست}» stay intact) and **never carry behavior**: callback data comes from
  stable route constants, so relabeling a button cannot change or break what
  it does.
- Operators edit per item via «تنظیمات عمومی ⚙️ → مدیریت متن‌ها ✍️»
  (update or reset-to-default; `isEditable` rows only — all seeded rows are
  editable).
- Rows for hidden placeholder sections (`tutorials`,
  `referral`, `pricing`, `representative_request`, `lucky_wheel`) stay seeded
  so their labels are ready when those features ship; the buttons themselves
  are not rendered in menus.
- `free_test` left the placeholder list in the free-trial phase: it is now
  the real main-menu trial button «اکانت تست رایگان 🎁», rendered
  conditionally (feature enabled + ≥ 1 trial-ready panel — see
  `docs/free-trial-architecture.md`). Its seeded default was updated from
  the literal-brace placeholder «اشتراک رایگان {تست}»; operator-customized
  labels are, as always, untouched by the seed.

| Key | Title | Default (Persian) | Editable |
| --- | --- | --- | --- |
| `buy_subscription` | خرید اشتراک | خرید اشتراک 🔐 | yes |
| `renew_service` | تمدید سرویس | تمدید سرویس ♻️ | yes |
| `extra_volume` | خرید حجم اضافه | خرید حجم اضافه ➕ | yes |
| `extra_time` | خرید زمان اضافه | خرید زمان اضافه ⏳ | yes |
| `my_services` | سرویس‌های من | سرویس‌های من 🛍 | yes |
| `wallet` | کیف پول | کیف پول + شارژ 🏦 | yes |
| `support` | پشتیبانی | پشتیبانی ☎️ | yes |
| `tutorials` | آموزش | آموزش 📚 | yes |
| `free_test` | اکانت تست رایگان | اکانت تست رایگان 🎁 | yes |
| `referral` | زیرمجموعه گیری | زیرمجموعه گیری 👥 | yes |
| `other_products` | محصولات دیگر | محصولات دیگر 🛍 | yes |
| `my_orders` | سفارش‌های من | سفارش‌های من 🧾 | yes |
| `pricing` | تعرفه اشتراک‌ها | تعرفه اشتراک‌ها 💵 | yes |
| `representative_request` | درخواست نمایندگی | درخواست نمایندگی 👨‍💼 | yes |
| `lucky_wheel` | گردونه شانس | گردونه شانس 🎲 | yes |
| `back` | بازگشت | بازگشت | yes |
| `back_to_list` | بازگشت به لیست | بازگشت به لیست | yes |
| `main_menu` | بازگشت به منوی اصلی | بازگشت به منوی اصلی | yes |
| `back_to_admin` | بازگشت به پنل ادمین | بازگشت به پنل ادمین | yes |
| `cancel` | لغو | لغو ❌ | yes |
| `confirm` | تایید | تایید ✅ | yes |
| `next` | بعدی | بعدی » | yes |
| `previous` | قبلی | « قبلی | yes |
| `new_ticket` | ایجاد تیکت جدید | ایجاد تیکت جدید ➕ | yes |
| `my_tickets` | تیکت‌های من | تیکت‌های من 📋 | yes |
| `reply_ticket` | پاسخ به تیکت | پاسخ به تیکت ✍️ | yes |
| `refresh` | بروزرسانی | بروزرسانی ♻️ | yes |
| `all_orders` | همه سفارش‌ها | همه سفارش‌ها 📋 | yes |
| `subscription_orders` | خرید اشتراک‌ها | خرید اشتراک‌ها 🔐 | yes |
| `other_product_orders` | سفارش‌های محصولات دیگر | محصولات دیگر 🛍 | yes |
| `payments` | پرداخت‌ها | پرداخت‌ها 💳 | yes |
| `wallet_transactions` | تراکنش‌های کیف پول | تراکنش‌های کیف پول 🏦 | yes |
| `back_to_support` | بازگشت به پشتیبانی | بازگشت به پشتیبانی | yes |
| `back_to_history` | بازگشت به سوابق | بازگشت به سوابق | yes |
