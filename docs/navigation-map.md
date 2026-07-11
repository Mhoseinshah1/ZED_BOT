# ZED_BOT complete navigation map

The full Telegram navigation tree — every page, its keyboard and every
button destination — produced by the corrective UI/UX audit. Use this
document to diff the implemented tree against the intended design and mark
corrections per page.

Audit status: **263 emitted button callbacks were cross-checked against all
189 registered handlers — zero dead buttons; every rendered page carries a
keyboard — zero dead-end pages** (locked by
`apps/bot/tests/navigation-integrity.test.ts`).

**LOCKED flows (approved as-is, documented but not changed):** the
«خرید اشتراک» subscription purchase (panel-first → category → product →
pre-invoice → payment), OTHER_PRODUCT checkout, and their separation.

Legend: `»` opens page · *(flow)* switches to a text-input flow ·
labels in ButtonText are operator-editable.

---

## Entry gates

| step | page | buttons |
| --- | --- | --- |
| `/start` | terms page (when not yet accepted) | قبول قوانین » `terms:accept` |
| force-join gate | join-channels page (when enabled) | عضو شدم ✅ » `force_join:check` |
| main menu | `start_text` template + user keyboard | see below |

`user:menu` and `common:back` both re-render the main menu.

## User main menu (7 buttons)

| button (ButtonText key) | callback | destination |
| --- | --- | --- |
| خرید اشتراک 🔐 (`buy_subscription`) | `user:buy` | subscription purchase — **LOCKED** |
| تمدید سرویس ♻️ (`renew_service`) | `user:renew` | renewal flow |
| سرویس‌های من 🛍 (`my_services`) | `user:services` | services list |
| کیف پول + شارژ 🏦 (`wallet`) | `user:wallet` | wallet page |
| محصولات دیگر 🛍 (`other_products`) | `user:other_products` | OTHER_PRODUCT purchase — separate section, **LOCKED** |
| سفارش‌های من 🧾 (`my_orders`) | `user:orders` | orders & history hub |
| پشتیبانی ☎️ (`support`) | `user:support` | ticket landing |

Hidden (unfinished; callbacks still answered for old keyboards): referral,
free_test, lucky_wheel, tutorials, pricing, representative_request.

### خرید اشتراک — LOCKED flow (documented only)

`user:buy` » panel list (`user:buy:panel:<sid>`) » categories
(`user:buy:cat:…`) » products (`user:buy:prod:…`) » **pre-invoice**
(product, category, panel/location/volume/duration, optional discount code
*(flow `checkout:discount`)*, price/discount/total, wallet balance) with:
پرداخت با کیف پول (when balance suffices, confirm screen) · پرداخت
کارت‌به‌کارت » payment page (tap-to-copy card + amount, receipt upload
*(flow `payment:receipt`)*) · انصراف. OTHER_PRODUCT rides the same engine
from its own entry (below) and keeps its post-payment required-info notice.

### تمدید سرویس

`user:renew` » renewable services list » renewal pre-invoice (discount
*(flow `renew:discount`)* / wallet / card-to-card, same payment page).

### سرویس‌های من

| page | buttons |
| --- | --- |
| list (`user:svc:list:<page>`) | one per service » `user:svc:view:<sid>` · pagination · بازگشت به منو |
| detail (`user:svc:view:<sid>`) | بروزرسانی اطلاعات ♻️ · لینک اشتراک 🔗 · کانفیگ‌ها 📄 · تغییر لینک اشتراک 🔄 (»confirm) · خرید حجم اضافه ➕ » `user:ev:svc:<sid>` · خرید زمان اضافه ⏳ » `user:et:svc:<sid>` · خاموش/روشن کردن سرویس (»confirm) · بازگشت به لیست · بازگشت به منو |
| toggle / regen confirms | تایید ✅ · انصراف » detail |
| extra volume / extra time | plan pick » pre-invoice (discount *(flows `extra_volume:discount` / `extra_time:discount`)* / wallet / card) |

Empty state: `no_services_text` template + خرید اشتراک + بازگشت به منو.

### کیف پول + شارژ

| page | buttons |
| --- | --- |
| wallet page (`user:wallet`) | افزایش موجودی 💰 *(flow `wallet:topup:amount`)* · تاریخچه تراکنش‌ها 📋 · بروزرسانی ♻️ · بازگشت به منو |
| transactions (paged) | pagination · بازگشت به کیف پول · بازگشت به منو |
| top-up | amount *(flow)* » payment page (card-to-card + receipt upload) |

Top-up limits/instruction text are the operator-editable Phase 22 Settings.

### محصولات دیگر (separate from خرید اشتراک — LOCKED)

`user:other_products` » categories » products » pre-invoice (incl. delivery
type + required-info notice) » card-to-card payment. After approval:
auto-delivery from stock or the manual path; «تکمیل اطلاعات سفارش 📝»
(`user:op:info:<sid>`, *(flow `other_product:info`)*) resumes required info.

### سفارش‌های من (hub)

| page | buttons |
| --- | --- |
| hub (`user:orders`) | همه سوابق 🧾 » `user:hist:list:1` · محصولات دیگر 🛍 » `user:orders:list:1` · پرداخت‌ها 💳 » `user:payhist:list:1` · کیف پول 🏦 » `user:wallet` · بازگشت به منو |
| همه سوابق (paged) | one row per order/payment » `user:hist:view:o|p:<sid>` · pagination · بازگشت » hub · بازگشت به منو |
| order detail | مشاهده سرویس 🛍 (when linked) · مشاهده جزئیات محصول دیگر 🛍 (OTHER_PRODUCT » Phase 29 detail) · مشاهده پرداخت 💳 · بازگشت به سوابق · بازگشت » hub |
| محصولات دیگر list (paged) | rows » `user:orders:view:<sid>` · pagination · بازگشت » hub · بازگشت به منو (empty: `no_orders_text`) |
| OP order detail | تکمیل اطلاعات سفارش 📝 (waiting-info) · بازگشت به سفارش‌ها · بازگشت به منو — shows delivered manual text / stock content for the owner only |
| پرداخت‌ها (paged) | rows » `user:payhist:view:<sid>` · pagination · بازگشت » hub · بازگشت به منو |
| payment detail | مشاهده سفارش 🧾 (when linked) · مشاهده کیف پول 🏦 (approved top-ups) · بازگشت به پرداخت‌ها · بازگشت » hub |

### پشتیبانی

| page | buttons |
| --- | --- |
| landing (`user:support`, `support_text` template) | تیکت جدید ➕ *(flows `support:subject` » `support:message`)* · تیکت‌های من 🧾 » list · بازگشت به منو |
| list (paged) | rows » `user:sup:view:<sid>` · pagination · بازگشت به پشتیبانی (empty: `no_tickets_text` + تیکت جدید) |
| detail | پاسخ دادن ✍️ *(flow `support:reply`, open tickets)* · تیکت‌های من 🧾 · بازگشت به پشتیبانی |

---

## Admin main menu (`/admin`, 11 buttons)

| button | callback | destination |
| --- | --- | --- |
| مالی 💎 | `admin:finance` | finance hub |
| رسیدهای تایید نشده 💵 | `admin:receipts` | receipt review |
| مدیریت کاربران 👤 | `admin:users` | user management |
| تنظیمات عمومی ⚙️ | `admin:general_settings` | settings hub (text management) |
| مدیریت محصولات/پلن‌ها | `admin:products` | product management |
| مدیریت پنل‌ها | `admin:panels` | panel management |
| محصولات دیگر / سفارش‌های محصولات دیگر | `admin:other_products` | manual orders + stock |
| تیکت‌های پشتیبانی 🎫 | `admin:support` | ticket admin |
| پیام همگانی 📣 | `admin:broadcast` | broadcast |
| گزارشات / بکاپ | `admin:reports_backup` | health/backup tools |

Hidden (callbacks still answered): panel features, bot update, tutorials,
mini-app settings, custom service price.

### مالی 💎

| page | buttons |
| --- | --- |
| hub | روش‌های پرداخت 💳 · تنظیمات پرداخت و کیف پول ⚙️ · رسیدهای تایید نشده 💵 · گزارش مالی 📊 » `admin:fin:reports` · بازگشت به منوی ادمین |
| روش‌های پرداخت » کارت‌به‌کارت | gateway list » gateway page (toggle, min/max *(flows)*, instruction, کارت‌ها » accounts list » add *(flow)* / toggle w/ confirm) |
| تنظیمات پرداخت و کیف پول | toggles (top-up / wallet payment) · min/max/instruction/notice *(flows)* · بازگشت |
| گزارش مالی 📊 | ranges امروز/۷روز/۳۰روز/همه » dashboard · آخرین پرداخت‌ها 💳 (paged » detail » بررسی رسید/مشاهده سفارش) · آخرین سفارش‌ها 🧾 (paged » detail » سفارش دستی/پرداخت) · بازگشت به مالی |

### رسیدهای تایید نشده 💵

list (paged) » receipt detail (media + masked card) » تایید ✅ (confirm;
OTHER_PRODUCT branches to auto-stock or manual init) · رد ❌ *(flow
`receipt:reject` — reason sent to the user)* · back.

### مدیریت کاربران 👤

hub (جستجوی کاربر 🔎 *(flow)* · کاربران اخیر 👤) » results » user page
(کیف پول کاربر 🏦 » افزایش ➕ / کسر ➖ *(amount+reason flows, confirm)*,
بازگشت‌ها) — Phase 20 wallet adjustments.

### تنظیمات عمومی ⚙️ » مدیریت متن‌ها ✍️

پیام‌ها/قالب‌ها 📝 and متن دکمه‌ها 🔘 (paged lists, 🔒 for non-editable) »
detail (escaped current/default previews) » ویرایش ✏️ *(flows
`admin_texts:template|button`)* · بازنشانی به پیش‌فرض ♻️ (confirm) · backs.

### مدیریت محصولات/پلن‌ها and مدیریت پنل‌ها

Category/product CRUD wizards and panel list » panel detail » edit/test
wizards (pre-existing flows; paged lists, back buttons throughout).

### محصولات دیگر / سفارش‌های محصولات دیگر

| page | buttons |
| --- | --- |
| landing | counters + همه سفارش‌های باز · در انتظار اطلاعات 📝 · آماده تحویل 📦 · تحویل‌شده ✅ · جستجوی سفارش 🔎 *(flow)* · مدیریت موجودی محصولات 🎟 · بازگشت |
| filtered lists (paged) | rows » `admin:mo:view:<sid>` |
| manual-order detail | تحویل سفارش 📦 *(flow + confirm — claim→send→finalize)* · پیام تکمیل اطلاعات 📝 (reminder) · backs (list/search/landing) |
| مدیریت موجودی 🎟 | product rows (🚨/⚠️/🎟/📦 badges) » product page |
| stock product page | افزودن آیتم ➕ *(flows)* · افزودن گروهی ➕➕ *(flow)* · مشاهده آیتم‌ها (paged; release/disable reserved w/ guards) · تنظیم/حذف هشدار کمبود 🔔 *(flow)* · toggle استاک · بازگشت |

### تیکت‌های پشتیبانی 🎫 / پیام همگانی 📣 / گزارشات و بکاپ

Tickets: counters landing » filters (paged) » detail » پاسخ ✍️ *(flow)* /
بستن ✅ (confirm). Broadcast: landing » ساخت پیام ➕ *(flow » audience with
live estimates » preview » تست 🧪 / شروع 🚀 confirm)* · لیست ارسال‌ها
(paged » detail w/ refresh). Reports/backup: وضعیت سیستم 🩺 (refresh) ·
ساخت بکاپ 💾 (confirm, OWNER) · لیست بکاپ‌ها (paged, download) · پاکسازی 🧹
(confirm, OWNER) · راهنمای Restore ♻️ (instructions only).

---

## Known intentional behaviors

- Old-keyboard compatibility: every legacy callback of hidden sections and
  renamed lists keeps answering.
- «سفارش‌های من» hub title is «سفارش‌ها و سوابق من 🧾» (broader content).
- Delivered stock content is visible only in the Phase 29 OP order detail;
  admin pages never show it.
- Admin labels are hardcoded; user main-menu labels are ButtonText-backed.
