# MessageTemplate registry

Generated from `packages/database/src/seed-data.ts`
(`INITIAL_MESSAGE_TEMPLATES`) — the single source of default copy. The seed
creates missing rows and refreshes stored **defaults**; operator-customized
current values are never overwritten (see `docs/text-system.md`).

- Content limit: **1..4000 characters** (`TEMPLATE_CONTENT_MAX`).
- Variables: each row's explicit allowed list; edits may never introduce
  other placeholders, and secret-shaped names are always rejected.
- Fallback rule: DB `currentContent` → caller fallback → registry default →
  the bare key (never a crash). Reads cache for 30s.
- Operators edit per item via «تنظیمات عمومی ⚙️ → مدیریت متن‌ها ✍️»
  (update or reset-to-default; `isEditable` rows only — all seeded rows are
  editable).

| Key | Title | Default (Persian) | Variables | Editable |
| --- | --- | --- | --- | --- |
| `start_text` | پیام شروع | سلام {first_name} عزیز 👋<br><br>به {bot_name} خوش آمدید.<br><br>از طریق این ربات می‌توانید سرویس VPN، محصولات دیجیتال، کیف پول، سفارش‌ها و پشتیبانی خود را مدیریت کنید.<br><br>وضعیت فروش: {sales_status} | `{first_name}` `{username}` `{bot_name}` `{sales_status}` | yes |
| `bot_off_text` | پیام حالت تعمیرات | ربات در حال بروزرسانی است. لطفاً کمی بعد دوباره تلاش کنید. | — | yes |
| `blocked_text` | پیام کاربر مسدود | حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید. | — | yes |
| `terms_text` | متن قوانین | برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید. | — | yes |
| `force_join_text` | پیام عضویت اجباری | برای ادامه، ابتدا در کانال‌های مشخص‌شده عضو شوید. | — | yes |
| `support_text` | پیام پشتیبانی | برای ارتباط با پشتیبانی پیام خود را ارسال کنید. | — | yes |
| `faq_text` | سوالات متداول | سوالات متداول به زودی تکمیل می‌شود. | — | yes |
| `wallet_header_text` | عنوان صفحه کیف پول | کیف پول و حساب کاربری 🏦 | — | yes |
| `wallet_topup_amount_prompt` | درخواست مبلغ شارژ کیف پول | مبلغ موردنظر برای افزایش موجودی را به تومان وارد کنید. | — | yes |
| `wallet_topup_preview_note` | توضیح پیش‌فاکتور شارژ کیف پول | پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد. | — | yes |
| `wallet_empty_transactions_text` | پیام نبود تراکنش | هنوز تراکنشی برای کیف پول شما ثبت نشده است. | — | yes |
| `no_services_text` | پیام نبود سرویس | هنوز سرویسی برای شما ثبت نشده است. | — | yes |
| `no_orders_text` | پیام نبود سفارش | هنوز سفارشی ثبت نکرده‌اید. | — | yes |
| `no_tickets_text` | پیام نبود تیکت | هنوز تیکتی ثبت نکرده‌اید. | — | yes |
| `no_payments_text` | پیام نبود پرداخت | هنوز پرداختی برای شما ثبت نشده است. | — | yes |
| `no_other_product_orders_text` | پیام نبود سفارش محصولات دیگر | هنوز سفارش محصول دیگری ثبت نکرده‌اید. | — | yes |
| `support_landing_text` | متن صفحه پشتیبانی | از این بخش می‌توانید با پشتیبانی در ارتباط باشید و پاسخ تیکت‌های قبلی را پیگیری کنید. | — | yes |
| `support_subject_prompt` | درخواست موضوع تیکت | موضوع تیکت را وارد کنید. ({min} تا {max} کاراکتر) | `{min}` `{max}` | yes |
| `support_message_prompt` | درخواست متن تیکت | پیام خود را برای پشتیبانی ارسال کنید. (حداکثر {max} کاراکتر) | `{max}` | yes |
| `support_reply_prompt` | درخواست پاسخ تیکت | پاسخ خود را ارسال کنید. (حداکثر {max} کاراکتر) | `{max}` | yes |
| `support_empty_tickets_text` | پیام نبود تیکت (پشتیبانی) | هنوز تیکتی ثبت نکرده‌اید. | — | yes |
| `support_ticket_created_text` | پیام ثبت تیکت | تیکت شما با موفقیت ثبت شد ✅ | — | yes |
| `history_landing_text` | متن صفحه سوابق | سوابق سفارش‌ها، پرداخت‌ها و تراکنش‌های کیف پول شما در این بخش قابل مشاهده است. | — | yes |

## Automated notification templates (feat/notification-retention-engine, Phase 1)

Rendered by the worker delivery from a safe snapshot (keys mirror
`@zedbot/shared` `NOTIF_TEMPLATE_KEYS`). Variables are safe display values only.

| Key | Title | Variables | Editable |
| --- | --- | --- | --- |
| `notif_service_expiry` | اعلان نزدیک شدن انقضای سرویس | `{service_name}` `{time_left}` | yes |
| `notif_service_expired` | اعلان انقضای سرویس | `{service_name}` | yes |
| `notif_service_traffic` | اعلان مصرف حجم سرویس | `{service_name}` `{percent}` | yes |
| `notif_service_limited` | اعلان محدود شدن سرویس | `{service_name}` | yes |
| `notif_trial_near_expiry` | اعلان نزدیک شدن انقضای سرویس تست | `{service_name}` `{time_left}` | yes |
| `notif_trial_expired` | اعلان انقضای سرویس تست | `{service_name}` | yes |
