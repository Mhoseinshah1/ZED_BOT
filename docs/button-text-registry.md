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
- **Duplicate-label restriction (menu-keyboard-mode phases)**: the 8 user
  main-menu keys (`buy_subscription`, `renew_service`, `my_services`,
  `wallet`, `other_products`, `my_orders`, `support`, `free_test` —
  `MAIN_MENU_BUTTON_KEYS`) may never share a current label, and neither
  may the 9 admin main-menu keys (the `admin_*` rows below —
  `ADMIN_MAIN_MENU_BUTTON_KEYS`), because in `REPLY` keyboard mode
  incoming text is resolved against the current labels of each menu. An
  edit that would collide with another button's current label **in the
  same menu** is rejected with
  «این متن دکمه با یکی دیگر از دکمه‌های همین منو یکسان است.». The two
  menus are separate reply-routing contexts, so the same label may exist
  in both; all other rows are unaffected. See
  `docs/user-menu-keyboard-modes.md` and
  `docs/admin-menu-keyboard-mode.md`.
- Rows for hidden placeholder sections (`tutorials`,
  `referral`, `pricing`, `representative_request`, `lucky_wheel`) stay seeded
  so their labels are ready when those features ship; the buttons themselves
  are not rendered in menus.
- `free_test` left the placeholder list in the free-trial phase: it is now
  the real main-menu trial button «اکانت تست رایگان 🎁», rendered
  conditionally (feature enabled + ≥ 1 trial-ready panel — see
  `docs/free-trial-architecture.md`). Its seeded default was updated from
  the literal-brace placeholder «اشتراک رایگان {تست}»; operator-customized
  labels are, as always, untouched by the seed. The
  free-trial-button-visibility fix reuses this SAME key for both keyboard
  modes — no duplicate entry was added, edited labels keep routing to the
  stable `FREE_TRIAL` action, and behavior never binds to the visible
  Persian text.
- Admin-page button labels («تنظیمات اکانت تست 🎁», «فعال کردن تست
  رایگان», «غیرفعال کردن تست رایگان», «مشاهده پنل‌های آماده», «مشاهده
  پنل‌های ناقص», «بروزرسانی وضعیت ♻️» and the rest of the admin tree) are
  code-level constants bound to stable callback ids, NOT registry rows.
  The one exception (admin-menu-keyboard-mode phase) is the admin **main
  menu**: its 9 top-level navigation labels are the `admin_*` rows below
  (defaults = the exact approved inline labels), so reply-keyboard
  routing keeps working after operator edits — deeper admin pages stay
  code-level. See `docs/admin-menu-keyboard-mode.md`.

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
| `admin_finance` | منوی ادمین: مالی | مالی 💎 | yes |
| `admin_users` | منوی ادمین: مدیریت کاربران | مدیریت کاربران 👤 | yes |
| `admin_products` | منوی ادمین: محصولات/پلن‌ها | مدیریت محصولات/پلن‌ها 📦 | yes |
| `admin_panels` | منوی ادمین: مدیریت پنل‌ها | مدیریت پنل‌ها 🖥 | yes |
| `admin_other_products` | منوی ادمین: محصولات دیگر | محصولات دیگر / سفارش‌های محصولات دیگر | yes |
| `admin_support_tickets` | منوی ادمین: تیکت‌ها | تیکت‌های پشتیبانی 🎫 | yes |
| `admin_broadcast` | منوی ادمین: پیام همگانی | پیام همگانی 📣 | yes |
| `admin_general_settings` | منوی ادمین: تنظیمات عمومی | تنظیمات عمومی ⚙️ | yes |
| `admin_reports_backup` | منوی ادمین: گزارشات / بکاپ | گزارشات / بکاپ 📊 | yes |
| `admin_return_user_menu` | منوی ادمین: بازگشت به منوی کاربر | بازگشت به منوی کاربر 👤 | yes |

## Automated notification buttons (feat/notification-retention-engine, Phase 1)

Rendered into a notification's inline keyboard (keys mirror `@zedbot/shared`
`NOTIF_BUTTON_KEYS`). Callback data is `ntf:<shortId>:<action>` — never derived
from these labels.

| Key | Title | Default | Editable |
| --- | --- | --- | --- |
| `notif_btn_open_service` | اعلان: مشاهده سرویس | مشاهده سرویس 👁 | yes |
| `notif_btn_renew_service` | اعلان: تمدید سرویس | تمدید سرویس ♻️ | yes |
| `notif_btn_buy_extra_volume` | اعلان: خرید حجم اضافه | خرید حجم اضافه ➕ | yes |
| `notif_btn_dismiss` | اعلان: بستن | بستن ✖️ | yes |

## Checkout-payment reminder buttons (Phase 2)

Callback data is `ntf:<shortId>:<action>` (c=continue/reselect, d=view, n=suppress).

| Key | Title | Default | Editable |
| --- | --- | --- | --- |
| `notif_btn_continue_checkout` | اعلان: ادامه پرداخت | ادامه پرداخت 💳 | yes |
| `notif_btn_checkout_details` | اعلان: مشاهده جزئیات سفارش | مشاهده جزئیات سفارش 🧾 | yes |
| `notif_btn_stop_checkout_reminders` | اعلان: دیگر یادآوری نکن | دیگر یادآوری نکن 🔕 | yes |
| `notif_btn_reselect_payment` | اعلان: انتخاب روش پرداخت | انتخاب روش پرداخت 💳 | yes |
| `notif_btn_view_order` | اعلان: مشاهده سفارش | مشاهده سفارش 🧾 | yes |
| `notif_btn_stop_payment_reminders` | اعلان: عدم یادآوری این سفارش | عدم یادآوری این سفارش 🔕 | yes |
