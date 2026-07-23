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

## Checkout-payment reminder templates (Phase 2)

| Key | Title | Variables | Editable |
| --- | --- | --- | --- |
| `notification_abandoned_checkout` | اعلان سفارش ناقص | `{checkout_reference}` `{product_name}` `{payable_amount}` `{expires_in}` | yes |
| `notification_payment_retry` | اعلان پرداخت ناموفق | `{checkout_reference}` `{product_name}` `{payable_amount}` `{payment_method}` | yes |
| `notification_customer_winback` | اعلان بازگشت مشتری | `{inactive_days}` `{last_service_name}` `{last_product_name}` | yes |

## Wallet auto-renewal pre-charge notice (Corrective Phase)

| key | category | variables | notes |
| --- | --- | --- | --- |
| `notification_wallet_auto_renewal_upcoming` | notification | `service_name`, `product_name`, `current_price`, `maximum_charge`, `expected_charge_time`, `service_expiry` | Durable advance notice ~24h before a wallet auto-renewal charge. No wallet balance. Delivered variables are re-rendered from LIVE state at send time (never a stale price). See [wallet-auto-renewal-precharge-notices.md](./wallet-auto-renewal-precharge-notices.md). |

Note: the former at-charge `AUTO_RENEWAL_CHARGING_TEXT` "renewing now" message was removed — the advance notice replaces it.

## Device connection guides (feat/device-connection-guides)

| Key | Category | Variables | Notes |
| --- | --- | --- | --- |
| `connection_guides_disabled` | empty_state | — | Shown when a guide callback fires while the master switch is off. |
| `connection_guides_choose_platform` | general | `service_name` | Platform-selection page header. |
| `connection_guides_choose_app` | general | `device`, `service_name` | Application-selection page header. |
| `connection_guides_app_page_intro` | general | `app`, `service_name` | Guide page intro (name HTML-escaped). |
| `connection_guides_no_apps` | empty_state | — | No active guide app configured. |
| `connection_guides_no_payload` | empty_state | — | Service has no connection payload. |
| `connection_guides_stale_app` | empty_state | — | Selected app became inactive. |
| `connection_guides_support_handoff` | support | `service_name`, `device`, `app` | Support prompt (no secret). |
| `connection_guides_service_active` | general | — | Status decision: ACTIVE. |
| `connection_guides_service_disabled` | general | — | Status decision: DISABLED. |
| `connection_guides_service_expired` | general | — | Status decision: EXPIRED. |
| `connection_guides_service_limited` | general | — | Status decision: LIMITED. |
| `connection_guides_service_unavailable` | general | — | FAILED/CREATING/DELETED safe explanation. |

## Service self-diagnostics (feat/service-self-diagnostics)

Operator-editable wrapper copy only; per-check lines + machine codes are code
constants. Rendered as escaped plain text and clamped under Telegram's limit.

| Key | Category | Variables | Notes |
| --- | --- | --- | --- |
| `service_diagnostics_disabled` | diagnostics | — | Feature off notice. |
| `service_diagnostics_running` | diagnostics | — | Transient "checking..." state. |
| `service_diagnostics_stale` | diagnostics | — | Expired report; re-run. |
| `service_diagnostics_report_intro` | diagnostics | `service_name` | Report header. |
| `service_diagnostics_healthy` | diagnostics | — | Overall: HEALTHY. |
| `service_diagnostics_action_required` | diagnostics | — | Overall: ACTION_REQUIRED. |
| `service_diagnostics_degraded` | diagnostics | — | Overall: DEGRADED. |
| `service_diagnostics_unavailable` | diagnostics | — | Overall: UNAVAILABLE. |
| `service_diagnostics_needs_support` | diagnostics | — | Overall: NEEDS_SUPPORT. |
| `service_diagnostics_live_evidence` | diagnostics | `checked_at` | Live evidence line. |
| `service_diagnostics_stored_evidence` | diagnostics | `checked_at` | Stored/cache evidence line. |
| `service_diagnostics_cooldown` | diagnostics | `seconds` | Cooldown remaining. |
| `service_diagnostics_support_preview` | diagnostics | — | Support handoff preview intro. |
| `service_diagnostics_support_prompt` | diagnostics | — | "Write your message" prompt. |
| `service_diagnostics_limitations` | diagnostics | — | What the check can/can't inspect. |

## Public retail Pricing Catalog (feat/public-pricing-catalog)

| key | category | variables | notes |
| --- | --- | --- | --- |
| `pricing_page_intro` | pricing | — | «تعرفه‌ها» root intro. |
| `pricing_page_disclaimer` | pricing | — | Retail-only price disclaimer (root + detail). |
| `pricing_page_empty_services` | pricing | — | Empty service section. |
| `pricing_page_empty_other` | pricing | — | Empty other-product section. |
| `pricing_page_product_unavailable` | pricing | — | Stale/forged/hidden product toast. |

## Admin-controlled unified purchase menu (feat/admin-controlled-unified-purchase-menu)

| key | category | variables | notes |
| --- | --- | --- | --- |
| `purchase_hub_intro` | menu | — | Combined-mode purchase hub intro. Bounded at render time; create-if-missing (operator edits preserved). See `docs/combined-purchase-menu.md`. |

## Rendering budgets (Pricing Catalog)

The `pricing_page_*` templates are editable up to the generic maximum, but each
is bounded to a per-sink Telegram budget when rendered (root/detail/empty pages;
`pricing_page_product_unavailable` is bounded to the small `answerCallbackQuery`
toast limit with a safe fallback when blank). No valid operator edit can push a
Pricing page past Telegram's limit or silently fail; the stored content is never
altered. See `docs/public-pricing-catalog.md`.
