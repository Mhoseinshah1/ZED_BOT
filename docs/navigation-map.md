# ZED_BOT navigation map

The Telegram navigation tree as of **Corrective UI/UX Fix A** — every page,
its keyboard and every button destination. Use this document to diff the
implemented tree against the intended design and mark corrections per page.

**LOCKED flows (approved as-is):** the «خرید اشتراک» subscription purchase
(`user:buy`, panel-first → category → product → pre-invoice → payment),
the OTHER_PRODUCT checkout, and their separation.

Audit status (final production audit): **277 emitted button callbacks
cross-checked against all 204 registered routes — zero dead buttons, zero
orphan routes, zero dead-end pages, all callbacks < 64 bytes, every admin
route behind admin auth** (locked by
`apps/bot/tests/navigation-integrity.test.ts`; see
`docs/final-production-audit.md`).

Legend: `»` opens page · *(flow)* switches to a text-input flow.

---

## Entry gates

| step | page | buttons |
| --- | --- | --- |
| `/start` | terms page (when not yet accepted) | قبول قوانین » `terms:accept` |
| force-join gate | join-channels page (when enabled) | عضو شدم ✅ » `force_join:check` |
| main menu | `start_text` template + user keyboard | see below |

`user:menu` and `common:back` both re-render the main menu.

## User main menu (4 rows, ButtonText-backed)

| row | button → callback |
| --- | --- |
| 1 | خرید اشتراک 🔐 → `user:buy` (**LOCKED**) · تمدید سرویس ♻️ → `user:renew` |
| 2 | سرویس‌های من 🛍 → `user:services` · کیف پول + شارژ 🏦 → `user:wallet` |
| 3 | محصولات دیگر 🛍 → `user:other_products` (**LOCKED**, separate) · سفارش‌های من 🧾 → `user:orders` |
| 4 | پشتیبانی ☎️ → `user:support` |

Hidden until implemented (callbacks still answered with the placeholder
page for old keyboards): `user:referral`, `user:free_test`,
`user:lucky_wheel`, `user:tutorials`, `user:pricing`,
`user:representative_request`.

### خرید اشتراک — LOCKED flow (documented only)

`user:buy` » panel list » categories » products » pre-invoice (discount
*(flow `checkout:discount`)*, wallet payment when balance suffices,
card-to-card payment page with receipt upload *(flow `payment:receipt`)*).
OTHER_PRODUCT rides the same engine from its own entry and keeps its
post-payment required-info notice.

### تمدید سرویس

`user:renew` » renewable services list » `user:renew:svc:<sid>` service
summary + plans » renewal pre-invoice (discount / wallet / card-to-card).
The plans page's back returns to the renewal list (`user:renew:list:1`)
even when entered from a service detail (kept deliberately — documented in
`docs/bot-ui-contract.md`).

### سرویس‌های من

| page | buttons |
| --- | --- |
| list (`user:svc:list:<page>`) | one per service » `user:svc:view:<sid>` · pagination · بازگشت به منو |
| detail (`user:svc:view:<sid>`) | بروزرسانی اطلاعات ♻️ · لینک اشتراک 🔗 · کانفیگ‌ها 📄 · تغییر لینک اشتراک 🔄 (»confirm) · **تمدید سرویس ♻️ » `user:renew:svc:<sid>` (Fix A, when renewable)** · خرید حجم اضافه ➕ » `user:ev:svc:<sid>` · خرید زمان اضافه ⏳ » `user:et:svc:<sid>` · خاموش/روشن کردن سرویس (»confirm) · بازگشت به لیست · بازگشت به منوی اصلی |
| toggle / regen confirms | تایید ✅ · انصراف » detail |

### کیف پول + شارژ (Fix A layout)

| page | buttons |
| --- | --- |
| landing (`user:wallet`, header = `wallet_header_text`) | افزایش موجودی 💰 *(flow `wallet:topup:amount`, prompt = `wallet_topup_amount_prompt`)* / تاریخچه تراکنش‌ها 📋 · بروزرسانی ♻️ / بازگشت به منوی اصلی |
| transactions (paged, empty = `wallet_empty_transactions_text`) | pagination · بازگشت به کیف پول · بازگشت به منو |
| top-up pre-invoice (note = `wallet_topup_preview_note`) | ادامه و انتخاب روش پرداخت ✅ · تغییر مبلغ · لغو · بازگشت به کیف پول |

Landing shows identity (id/name/username/phone/joined), balance, and the
three counters (services, pending orders, referrals) only.

### محصولات دیگر (separate from خرید اشتراک — LOCKED)

`user:other_products` » categories » products » pre-invoice » card-to-card
payment. After approval: stock auto-delivery or the manual path;
«تکمیل اطلاعات سفارش 📝» (`user:op:info:<sid>`) resumes required info.

### سفارش‌های من

`user:orders` » history hub (همه سوابق 🧾 / محصولات دیگر 🛍 / پرداخت‌ها 💳 /
کیف پول 🏦) with paged lists, order/payment details and the Phase 29
OTHER_PRODUCT detail (delivered content for the owner only).

### پشتیبانی

`user:support` landing » تیکت جدید ➕ *(flows subject » message)* ·
تیکت‌های من 🧾 (paged » detail » پاسخ دادن ✍️ *(flow)*) · بازگشت به منو.

---

## Admin main menu (`/admin`, Fix A — 5 rows)

| row | button → callback |
| --- | --- |
| 1 | مالی 💎 → `admin:finance` · مدیریت کاربران 👤 → `admin:users` |
| 2 | مدیریت محصولات/پلن‌ها → `admin:products` · مدیریت پنل‌ها → `admin:panels` |
| 3 | محصولات دیگر / سفارش‌های محصولات دیگر → `admin:other_products` |
| 4 | تیکت‌های پشتیبانی 🎫 → `admin:support` · پیام همگانی 📣 → `admin:broadcast` |
| 5 | تنظیمات عمومی ⚙️ → `admin:general_settings` · گزارشات / بکاپ → `admin:reports_backup` |

Not rendered but still answered (old keyboards): `admin:receipts` (real
receipts list — reachable via مالی), plus the placeholders
`admin:panel_features`, `admin:update_bot`, `admin:tutorials`,
`admin:mini_app_settings`, `admin:custom_service_price`.

### مالی 💎 (Fix A landing)

| page | buttons |
| --- | --- |
| landing (`admin:finance`) | رسیدهای تاییدنشده 💵 » `admin:receipts` / روش‌های پرداخت 💳 · تنظیمات کیف پول و پرداخت 🏦 / مدیریت کیف پول کاربران 👤 » `admin:users` · گزارش مالی 📊 » `admin:fin:reports` / بازگشت به پنل ادمین |
| روش‌های پرداخت » کارت‌به‌کارت | gateway list » gateway page (toggle, min/max *(flows)*, instruction, کارت‌ها » accounts » add *(flow)* / toggle w/ confirm) — backs » `admin:finance` |
| تنظیمات کیف پول و پرداخت | toggles · min/max/instruction/notice *(flows)* · بازگشت » `admin:finance` |
| گزارش مالی 📊 | ranges » dashboard · آخرین پرداخت‌ها 💳 / آخرین سفارش‌ها 🧾 (paged » details » receipt review / manual order) · بازگشت به مالی |

### رسیدهای تاییدنشده 💵 (Fix B)

| page | buttons |
| --- | --- |
| list (`admin:receipts` / `admin:rec:list:<page>`) | one per receipt » `admin:rec:view:<sid>` · pagination · بازگشت به مالی |
| جزئیات رسید 🧾 (`admin:rec:view:<sid>`) | (pending only) تایید رسید ✅ · رد رسید ❌ / ارسال/مشاهده رسید و مشخصات 🧾 » `admin:rec:media:<sid>` (on-demand media) / افزایش موجودی کاربر 💰 » existing user wallet page · مدیریت/مسدودسازی کاربر 👤 » existing user profile / بازگشت به لیست (same page) · بازگشت به مالی |
| approve confirm / reject *(flow)* | result » بازگشت به لیست رسیدها · بازگشت به مالی; reject cancel » same detail |

User pages opened from a receipt gain «بازگشت به رسید 🧾» (context cleared
on the users landing / admin menu).

### محصولات دیگر 🛍 (Fix B landing)

| page | buttons |
| --- | --- |
| landing (`admin:other_products`, with counters) | مدیریت محصولات دیگر 🛍 » `admin:products` / سفارش‌های دستی 📦 » open list · در انتظار اطلاعات 📝 » info list / آماده تحویل 🚚 » ready list · تاریخچه تحویل ✅ » delivered list / مدیریت موجودی استاک 🎟 » `admin:stock:products` / بازگشت به پنل ادمین |
| filtered lists (paged) | rows » `admin:mo:view:<sid>` · جستجوی سفارش 🔎 *(flow)* · بازگشت به محصولات دیگر |
| manual-order detail | تحویل سفارش 📦 *(flow + confirm)* · پیام تکمیل اطلاعات 📝 · بازگشت به لیست (same filter/page) · بازگشت به محصولات دیگر |
| مدیریت موجودی استاک 🎟 | product rows (🚨/⚠️/🎟/📦 badges) » product page · بازگشت به محصولات دیگر |
| stock product page | افزودن آیتم تکی ➕ · افزودن گروهی ➕➕ *(flows)* / آیتم‌های موجود ✅ · رزروشده ⏳ / غیرفعال ⏸ · تاریخچه تحویل 📦 (status lists `admin:stock:items:<sid>:<a|r|x|d>:<page>`) / تنظیم حد هشدار 🔔 *(flow)* / پاک کردن حد هشدار (when set) / toggle استاک / بازگشت به لیست محصولات استاک / بازگشت به محصولات دیگر |
| status item lists | release/disable actions (AVAILABLE/RESERVED only; DELIVERED/DISABLED read-only) returning to the same status/page · pagination · بازگشت » product page |

### مدیریت کاربران 👤 (Fix C)

| page | buttons |
| --- | --- |
| landing (`admin:users`) | جستجوی کاربر 🔎 *(flow)* / کاربران اخیر 🕘 · مسدود 🚫 / فعال ✅ · غیرفعال ⏸ (`admin:users:ls:<r|b|a|d>:<page>`) / بازگشت به پنل ادمین |
| filtered lists (paged) | rows » `admin:users:view:<sid>` · pagination · بازگشت |
| user detail | کیف پول 💰 · سرویس‌ها 🛍 / سفارش‌ها 🧾 · پرداخت‌ها 💳 / مسدود 🚫 یا رفع مسدودی ✅ (»confirm) / بازگشت به رسید 🧾 (Fix B context) / بازگشت به نتایج یا لیست (same filter/page) / بازگشت به مدیریت کاربران / منوی ادمین |
| wallet page | افزایش ➕ · کاهش ➖ *(Phase 20 confirmed flow)* / تاریخچه تراکنش‌ها 📋 (paged) / backs |
| services/orders sub-pages (paged, read-only) | text rows · pagination · بازگشت به کاربر |
| payments sub-page (paged) | rows » `admin:rec:view:<sid>` (Fix B detail) · بازگشت به کاربر |

### مدیریت محصولات و پلن‌ها 🛍 (Fix C)

| page | buttons |
| --- | --- |
| root (`admin:products`) | لیست محصولات 🧾 · افزودن محصول ➕ (type chooser) / دسته‌بندی‌ها 🗂 · افزودن دسته‌بندی ➕ / محصولات اشتراک VPN 🔐 · محصولات دیگر 🛍 / بازگشت به پنل ادمین |
| product lists (`admin:prod:ls:<S|O|A|V|X>:<page>`) | rows » detail · pagination · افزودن ➕ · دسته‌بندی‌ها 🗂 · بازگشت به مدیریت محصولات |
| product detail | field edits · category/groups · (SERVICE) پنل/حجم/موقعیت · (OTHER) تحویل/اطلاعات/استاک 🎟 » `admin:stock:p:<sid>` · toggle · غیرفعال‌سازی (soft) · بازگشت به لیست (same filter/page) · بازگشت به مدیریت محصولات |
| categories | pre-existing lists/detail/wizard; delete = soft-deactivate only |

### مدیریت پنل‌ها 🖥 (Fix C)

| page | buttons |
| --- | --- |
| root (`admin:panels`) | لیست پنل‌ها 🧾 · افزودن پنل ➕ / پنل‌های فعال ✅ · غیرفعال ⏸ (`admin:panels:ls:<a|i>:<page>`) / بازگشت به پنل ادمین |
| lists (paged) | rows (icon, name, type, hostname) » detail · بازگشت به مدیریت پنل‌ها |
| panel detail | تست اتصال 🩺 · وضعیت / ویرایش نام/آدرس / اطلاعات ورود 🔑 (set/not-set only) · محصولات متصل 🛍 » `admin:panel:prods:<sid>` / feature/pricing/test/username/cfg pages / حذف (soft) / بازگشت به لیست پنل‌ها (same filter/page) / بازگشت به مدیریت پنل‌ها |

### Other admin sections (unchanged)

- **تیکت‌های پشتیبانی 🎫** — filters » detail » پاسخ ✍️ *(flow)* / بستن ✅.
- **پیام همگانی 📣** — draft *(flow)* » audience » preview » test/start.
- **تنظیمات عمومی ⚙️** — مدیریت متن‌ها ✍️ (templates/buttons list » edit
  *(flows)* / reset). The four wallet template keys are editable here.
- **گزارشات / بکاپ 🛡** — health, backups (OWNER), restore help.
