# ZED_BOT navigation map

> **Persian text alignment phase**: visible labels across the tree were
> aligned with `ZED_BOT_Master_Requirements_FA.docx` (see
> `docs/persian-text-alignment.md`). Row order inside two-button rows
> follows the document's right/left tables under the project convention
> (first array item = the document's RIGHT column). Service-detail rows
> 2/4/8 were reordered accordingly (لینک اشتراک 🔗+کانفیگ‌ها 📄 · تمدید
> سرویس ♻️+خرید حجم اضافه ➕ · بازگشت به لیست+بازگشت به منوی اصلی), the
> pre-invoice buttons became «پرداخت / تایید خرید ✅» / «ثبت کد تخفیف 🎟» /
> «بازگشت», the card-to-card screen gained «پرداخت کردم ✅» / «بازگشت»,
> and the admin root row labels gained their 🖥/📦/📊 emojis. Callback
> data did NOT change anywhere - labels only.

The Telegram navigation tree as of **Corrective UI/UX Fixes A–D** — every
page, its keyboard and every button destination. Use this document to diff
the implemented tree against the intended design and mark corrections per
page.

**LOCKED flows (approved as-is):** the «خرید اشتراک» subscription purchase
(`user:buy`, panel-first → category → product → pre-invoice → payment),
the OTHER_PRODUCT checkout, and their separation.

Audit status (final production audit, re-run after Fix D): **279
emitted button callbacks cross-checked against all 206 registered routes — zero dead buttons, zero
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

## User main menu (4 rows + conditional trial row, ButtonText-backed)

| row | button → callback |
| --- | --- |
| 1 | خرید اشتراک 🔐 → `user:buy` (**LOCKED**) · تمدید سرویس ♻️ → `user:renew` |
| 2 | سرویس‌های من 🛍 → `user:services` · کیف پول + شارژ 🏦 → `user:wallet` |
| 3 | محصولات دیگر 🛍 → `user:other_products` (**LOCKED**, separate) · سفارش‌های من 🧾 → `user:orders` |
| 3½ (conditional) | اکانت تست رایگان 🎁 → `user:free_test` — rendered ONLY when free trials are globally enabled AND ≥ 1 trial-ready panel exists — ready includes free capacity (`getFreeTrialMenuAvailability`, the same shared policy the admin «تنظیمات اکانت تست 🎁» diagnostics page reads; feature-gated, never a placeholder) |
| 4 | پشتیبانی ☎️ → `user:support` |

Hidden until implemented (callbacks still answered with the placeholder
page for old keyboards): `user:referral`,
`user:lucky_wheel`, `user:tutorials`, `user:pricing`,
`user:representative_request`. `user:free_test` left this list in the
free-trial phase — it is now the real trial flow above.

**Keyboard mode (menu-keyboard-mode phase):** the table above is the
`INLINE` (default) rendering. When the admin selects `REPLY` mode
(«تنظیمات عمومی ⚙️ → نوع نمایش منوی کاربر»), the SAME rows/labels render
as a persistent reply keyboard, and the row labels arrive as **message
text** routed by the shared dispatcher
(`apps/bot/src/handlers/user-menu-actions.ts`) to the same section
entries the callbacks above use — exact current-label match only, active
flows and commands keep priority. See `docs/user-menu-keyboard-modes.md`.

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

Trial-lifecycle phase: `FREE_TRIAL` services render the SAME per-action
buttons as paid ones — each is decided by panel capability/state, remote
model, status and quota (`resolveServiceDetailActions`), never by
`source`; the detail text carries «نوع سرویس: اکانت تست رایگان» /
«شروع‌شده با اکانت تست». See `docs/free-trial-lifecycle.md`.

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

**Specialized-workflows phase — `cinput:*` namespace** (pre-settlement
customer-input form, flow `customer_input:form`; see
`docs/specialized-product-workflows.md`). Opened automatically after a
card-to-card receipt when the checkout's frozen snapshot collects info
before approval, or via the post-payment «تکمیل اطلاعات سفارش 📝» button:

| page | buttons |
| --- | --- |
| entry/re-entry | ادامه فرم 📝 / تکمیل اطلاعات سفارش 📝 » `cinput:start:<checkout-prefix>` (owner-scoped 12-char prefix) |
| field page *(flow: text answer)* | (SELECT) `1) گزینه…` » `cinput:opt:<index>` (index only, never option text) · رد شدن ⏭ » `cinput:skip` (optional fields) · ⬅️ قبلی » `cinput:back` · انصراف » `cinput:cancel` |
| cancel confirm | بله، لغو شود » `cinput:cancel:yes` (row stays COLLECTING; result offers ادامه فرم 📝 » `cinput:start:…` + منوی اصلی) · ادامه فرم » `cinput:cancel:no` |
| review page (masked summary) | تایید و ثبت ✅ » `cinput:confirm` (the ONLY persistence point — never settles payment / creates orders / notifies admins) · ⬅️ قبلی · انصراف |

### سفارش‌های من 🧾 (Fix D landing)

| page | buttons |
| --- | --- |
| landing (`user:orders`, text = `history_landing_text`) | همه سفارش‌ها 📋 » `user:hist:list:1` / خرید اشتراک‌ها 🔐 » `user:hist:sub:1` · محصولات دیگر 🛍 » `user:orders:list:1` / پرداخت‌ها 💳 » `user:payhist:list:1` · تراکنش‌های کیف پول 🏦 » `user:hist:wtx:1` / بازگشت به منوی اصلی |
| همه/اشتراک lists (paged, empty = `no_orders_text`) | rows » order/payment detail · pagination · بازگشت به سوابق · منوی اصلی |
| order detail | مشاهده سرویس/محصول دیگر/پرداخت links · بازگشت به لیست (same list+page) · بازگشت به سوابق |
| پرداخت‌ها (paged, empty = `no_payments_text`) | rows » payment detail (returns to same page) |
| تراکنش‌های کیف پول (from history) | paged, empty = `wallet_empty_transactions_text`; backs » history landing (the wallet's own tx page keeps its wallet backs) |
| محصولات دیگر list (empty = `no_other_product_orders_text`) | Phase 29 list/detail unchanged (delivered content for the owner only) |

### اکانت تست رایگان 🎁 (free-trial phase)

| page | buttons |
| --- | --- |
| panel list (`user:free_test`, header «🎁 اکانت تست رایگان») | one per trial-ready panel «{لوکیشن} — تست {مدت} / {حجم}» » `user:ft:p:<sid>` · بازگشت به منوی اصلی |
| confirmation (`user:ft:p:<sid>`, specs + rules line + optional `free_trial_notice_text`) | دریافت اکانت تست ✅ » `user:ft:go:<sid>` / بازگشت » `user:free_test` |
| claim result (`user:ft:go:<sid>`) | success » مشاهده سرویس (`user:svc:view:<sid>`) · بازگشت به منوی اصلی — denial/uncertain » بازگشت به منوی اصلی |

Every step re-checks eligibility server-side; short ids resolve only
over the current trial-ready panel set. See
`docs/free-trial-architecture.md`.

### پشتیبانی 🎫 (Fix D)

| page | buttons |
| --- | --- |
| landing (`user:support`, text = `support_landing_text`) | ایجاد تیکت جدید ➕ *(flows subject » message, template prompts)* / تیکت‌های من 📋 / بازگشت به منوی اصلی |
| تیکت‌های من (paged, empty = `support_empty_tickets_text`) | rows » detail · pagination · بازگشت به پشتیبانی |
| ticket detail | (open) پاسخ به تیکت ✍️ *(flow)* / بروزرسانی ♻️ / بازگشت به تیکت‌های من (same page) / بازگشت به پشتیبانی — closed tickets hide the reply button |

---

## Admin main menu (`/admin`, Fix A — 5 rows + return row)

| row | button → callback |
| --- | --- |
| 1 | مالی 💎 → `admin:finance` · مدیریت کاربران 👤 → `admin:users` |
| 2 | مدیریت محصولات/پلن‌ها → `admin:products` · مدیریت پنل‌ها → `admin:panels` |
| 3 | محصولات دیگر / سفارش‌های محصولات دیگر → `admin:other_products` |
| 4 | تیکت‌های پشتیبانی 🎫 → `admin:support` · پیام همگانی 📣 → `admin:broadcast` |
| 5 | تنظیمات عمومی ⚙️ → `admin:general_settings` · گزارشات / بکاپ → `admin:reports_backup` |
| 6 | بازگشت به منوی کاربر 👤 → `user:menu` (the existing `CB.USER_MENU`) |

Row 6 completes the two-way User/Admin navigation (PR #96 added «پنل مدیریت 🛠»
to the user menu; this is the return leg). It is always the final full-width
row and reuses `CB.USER_MENU`: an inline tap goes through the normal user area
(`userAccessMiddleware → menuHandler → showUserMenu`), identical to `/menu`; in
REPLY admin mode the label resolves to the `RETURN_TO_USER_MENU` action, which
runs `ensureUserAccess` then the shared `showUserMenu`. The destination honors
the independently configured user menu mode (all four Admin×User INLINE/REPLY
transitions), and the user-access gates (maintenance / blocked / terms /
force-join) apply first — an active admin never bypasses them. Admin submenus
keep only their «بازگشت به پنل ادمین» back button; the admin main menu is the
single exit to the user surface.

Not rendered but still answered (old keyboards): `admin:receipts` (real
receipts list — reachable via مالی), plus the placeholders
`admin:panel_features`, `admin:update_bot`, `admin:tutorials`,
`admin:mini_app_settings`, `admin:custom_service_price`.

### مالی 💎 (Fix A landing)

| page | buttons |
| --- | --- |
| landing (`admin:finance`) | رسیدهای تاییدنشده 💵 » `admin:receipts` / روش‌های پرداخت 💳 · تنظیمات کیف پول و پرداخت 🏦 / مدیریت کیف پول کاربران 👤 » `admin:users` · گزارش مالی 📊 » `admin:fin:reports` / لیست پرداخت‌ها 💳 » `admin:fin:pay:all:1` · تطبیق مالی ⚖️ » `admin:fin:recon` / بازگشت به پنل ادمین |
| مدیریت روش‌های پرداخت 💳 (`admin:finance:methods`, provider LIST) | ONE button per provider `{emoji} {name} — {فعال ✅/غیرفعال ❌}` » `payprov:view:<KEY>` (KEY ∈ CARD_TO_CARD/WALLET/ZARINPAL/NOWPAYMENTS/TELEGRAM_STARS) / بازگشت به مالی |
| provider DETAIL (`payprov:view:<KEY>`) | فعال کردن *or* غیرفعال کردن » `payprov:toggle:<KEY>` (confirm page » `payprov:toggle:<KEY>:on\|off`, انصراف » detail) / تنظیمات » `payprov:settings:<KEY>` / تست اتصال » `payprov:test:<KEY>` (ZARINPAL·NOWPAYMENTS only) / بازگشت به روش‌های پرداخت |
| تنظیمات per provider | CARD_TO_CARD » card gateway page (toggle, min/max *(flows)*, instruction, کارت‌ها » accounts » add *(flow)* / toggle w/ confirm) — backs » `payprov:view:CARD_TO_CARD` · WALLET » تنظیمات کیف پول و پرداخت · online providers » read-only env-config page — back » detail |
| تنظیمات کیف پول و پرداخت | toggles · min/max/instruction/notice *(flows)* · بازگشت » `admin:finance` |
| گزارش مالی 📊 | ranges » dashboard · آخرین پرداخت‌ها 💳 / آخرین سفارش‌ها 🧾 (paged » details » receipt review / manual order) · بازگشت به مالی |
| تطبیق مالی ⚖️ (`admin:fin:recon`, **OWNER-only** — every route; non-OWNER admins get a safe toast, never data) | پرداخت‌های موفق تکراری » `admin:fin:recon:dup:1` / بازگشت به مالی |
| پرداخت‌های موفق تکراری ⚠️ (`admin:fin:recon:dup:<page>`, newest-first, 5/page, read-only) | one button per case (short id · provider · amount) » `admin:fin:recon:v:<sid>` · pagination · بازگشت » `admin:fin:recon` |
| case detail (`admin:fin:recon:v:<sid>`) | read-only safe fields (user, checkout/payment short ids + providers, amount, status, UTC time) — **no resolve/refund buttons** (see `docs/financial-reconciliation.md`) · بازگشت به لیست · بازگشت به مالی |

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
| landing (`admin:other_products`, with counters — incl. «در انتظار شارژ موجودی» when > 0) | مدیریت محصولات دیگر 🛍 » `admin:products` / سفارش‌های دستی 📦 » open list · در انتظار اطلاعات 📝 » info list / آماده تحویل 🚚 » ready list · تاریخچه تحویل ✅ » delivered list / مدیریت موجودی استاک 🎟 » `admin:stock:products` / بازگشت به پنل ادمین |
| filtered lists (paged; filters `admin:mo:list:<open\|info\|ready\|delivered\|stock>:<page>` — `stock` = paid orders parked AWAITING_STOCK) | rows » `admin:mo:view:<sid>` · در انتظار شارژ موجودی ⏳ (n) » `admin:mo:list:stock:1` (conditional, when parked orders exist) · جستجوی سفارش 🔎 *(flow)* · بازگشت به محصولات دیگر |
| manual-order detail (specialized records add frozen kind/profile labels + the customer-info presence line) | تحویل سفارش 📦 *(flow + confirm)* · تکمیل بدون متن ✅ » `admin:mo:deliver_done:<sid>` (PERSONALIZED_SERVICE only, offered on the delivery prompt) · مشاهده اطلاعات مشتری 🔒 » `admin:mo:cinfo:<sid>` (audited masked view » نمایش کامل 🔓 » `admin:mo:cinfo_full:<sid>`, separately audited) · پیام تکمیل اطلاعات 📝 · بازگشت به لیست (same filter/page) · بازگشت به محصولات دیگر |
| مدیریت موجودی استاک 🎟 | product rows (🚨/⚠️/🎟/📦 badges) » product page · بازگشت به محصولات دیگر |
| stock product page | افزودن آیتم تکی ➕ · افزودن گروهی ➕➕ *(flows; EMAIL_BOUNDARY/EXPLICIT_SEPARATOR products preview counts + masked ids » تایید و افزودن ✅ » `admin:stock:imp_confirm`)* / آیتم‌های موجود ✅ · رزروشده ⏳ / غیرفعال ⏸ · تاریخچه تحویل 📦 (status lists `admin:stock:items:<sid>:<a|r|x|d>:<page>`) / تنظیم حد هشدار 🔔 *(flow)* / تکمیل سفارش‌های در انتظار 🔁 » `admin:stock:retry:<sid>` / پاک کردن حد هشدار (when set) / toggle استاک / بازگشت به لیست محصولات استاک / بازگشت به محصولات دیگر |
| status item lists | release/disable actions (AVAILABLE/RESERVED only; DELIVERED/DISABLED read-only) returning to the same status/page · pagination · بازگشت » product page |

### مدیریت کاربران 👤 (Fix C)

| page | buttons |
| --- | --- |
| landing (`admin:users`) | جستجوی کاربر 🔎 *(flow)* / کاربران اخیر 🕘 · مسدود 🚫 / فعال ✅ · غیرفعال ⏸ (`admin:users:ls:<r|b|a|d>:<page>`) / بازگشت به پنل ادمین |
| filtered lists (paged) | rows » `admin:users:view:<sid>` · pagination · بازگشت |
| user detail | کیف پول 💰 · سرویس‌ها 🛍 / سفارش‌ها 🧾 · پرداخت‌ها 💳 / **مدیریت اکانت تست 🎁 » `admin:users:trial:<sid>` (trial-entitlement phase, table below)** / مسدود 🚫 یا رفع مسدودی ✅ (»confirm) / بازگشت به رسید 🧾 (Fix B context) / بازگشت به نتایج یا لیست (same filter/page) / بازگشت به مدیریت کاربران / منوی ادمین |
| wallet page | افزایش ➕ · کاهش ➖ *(Phase 20 confirmed flow)* / تاریخچه تراکنش‌ها 📋 (paged) / backs |
| services/orders sub-pages (paged, read-only) | text rows · pagination · بازگشت به کاربر |
| payments sub-page (paged) | rows » `admin:rec:view:<sid>` (Fix B detail) · بازگشت به کاربر |

#### مدیریت اکانت تست 🎁 (`admin:users:trial:<sid>`, trial-entitlement phase; any admin, OWNER-only where marked)

| page | buttons |
| --- | --- |
| «🎁 مدیریت اکانت تست کاربر» (summary: used/remaining, active trial, provisioning, last trial, cooldown end, access state, claim/grant counters, converted count — no secrets) | افزودن سهمیه تست » `admin:users:trial:g:<sid>` *(scope » count » expiry » reason flows, confirm » `…:gok`)* · تنظیم تعداد تست باقی‌مانده » `…:sr:<sid>` (**OWNER**, *(count » reason flows, confirm » `…:srok`)*) / ریست دسترسی تست » `…:rs:<sid>` *(reason flow, confirm » `…:rsok`)* · لغو دسترسی تست » `…:rv:<sid>` *(reason flow, confirm » `…:rvok`)* / رفع محدودیت زمانی » `…:cc:<sid>` (»confirm `…:ccok:<sid>`) · تنظیم محدودیت زمانی » `…:sc:<sid>` *(days » reason flows, confirm » `…:scok`)* / مسدودسازی موقت تست » `…:dn:<sid>` *(days » reason flows, confirm » `…:dnok`)* / مشاهده تاریخچه تست‌ها » `…:hist:<sid>:1` · مشاهده سرویس‌های تست » `…:svc:<sid>:1` / بازگشت به جزئیات کاربر » `admin:users:view:<sid>` |
| grant scope/panel picker | همه پنل‌ها » `…:gall` · پنل مشخص » `…:gp:<sid>:1` (paged ACTIVE panels » `…:gpanel:<psid>`) · انصراف » `…:cxl:<sid>` |
| grant expiry choice | بدون تاریخ انقضا » `…:gexp:none` · اعتبار برای چند روز » `…:gexp:days` *(days flow)* · انصراف |
| تاریخچه تست‌ها (`…:hist:<sid>:<page>`, 5/page: id, panel, status, frozen username, dates, «منبع سهمیه») | per undecided claim (**OWNER only**, PROVISIONING/MANUAL_REVIEW): تطبیق مجدد با پنل » `…:rec:<sid>:<cid>` · تایید ساخته‌شدن تست » `…:fc:<sid>:<cid>` · تایید ساخته‌نشدن تست / لغو و آزادسازی سهمیه » `…:fn:<sid>:<cid>` *(force warning + reason flow, confirm » `…:fok`)* / pagination / بازگشت » `admin:users:trial:<sid>` |
| سرویس‌های تست (`…:svc:<sid>:<page>`, read-only: username, status, expiry, «تبدیل‌شده به سرویس فعال» marker) | pagination / بازگشت » `admin:users:trial:<sid>` |

### مدیریت محصولات و پلن‌ها 🛍 (Fix C)

| page | buttons |
| --- | --- |
| root (`admin:products`) | لیست محصولات 🧾 · افزودن محصول ➕ (type chooser) / دسته‌بندی‌ها 🗂 · افزودن دسته‌بندی ➕ / محصولات اشتراک VPN 🔐 · محصولات دیگر 🛍 / بازگشت به پنل ادمین |
| product lists (`admin:prod:ls:<S|O|A|V|X>:<page>`) | rows » detail · pagination · افزودن ➕ · دسته‌بندی‌ها 🗂 · بازگشت به مدیریت محصولات |
| product detail | field edits (incl. پیام تکمیل سفارش » `admin:prod:fe:<sid>:cmt`, OTHER only) · category/groups · (SERVICE) پنل/حجم/موقعیت · (OTHER) نوع محصول » `admin:prod:kind:<sid>` (» `admin:prod:setkind:<sid>:<APPLE\|AI\|TGP\|GIFT\|GEN>`) · فرمت موجودی » `admin:prod:sparser:<sid>` (» `admin:prod:setsp:<sid>:<SL\|SEP\|EB>`, stock profiles only) · دریافت اطلاعات قبل از تایید رسید » `admin:prod:cba:<sid>` (info-collecting products only) · تحویل/اطلاعات/استاک 🎟 » `admin:stock:p:<sid>` · toggle · غیرفعال‌سازی (soft) · بازگشت به لیست (same filter/page) · بازگشت به مدیریت محصولات |
| OTHER_PRODUCT add-wizard kind branching (specialized-workflows phase, after the category step) | نوع محصول » `admin:prod:f:kind:<APPLE\|AI\|TGP\|GIFT\|GEN>` · (AI) اکانت آماده / اکانت شخصی برای مشتری » `admin:prod:f:ai:<ready\|pers>` · (gift) کد آماده از موجودی / تحویل دستی توسط ادمین » `admin:prod:f:gc:<stock\|manual>` · فرمت موجودی » `admin:prod:f:sp:<SL\|SEP\|EB>` · فرم اطلاعات مشتری » `admin:prod:f:fp:<AI\|NONE>` — every branch lands on the duration step; see `docs/specialized-product-workflows.md` |
| categories | pre-existing lists/detail/wizard; delete = soft-deactivate only |

### مدیریت پنل‌ها 🖥 (Fix C)

| page | buttons |
| --- | --- |
| root (`admin:panels`) | لیست پنل‌ها 🧾 · افزودن پنل ➕ / پنل‌های فعال ✅ · غیرفعال ⏸ (`admin:panels:ls:<a|i>:<page>`) / بازگشت به پنل ادمین |
| lists (paged) | rows (icon, name, type, hostname) » detail · بازگشت به مدیریت پنل‌ها |
| panel detail | تست اتصال 🩺 · وضعیت / ویرایش نام/آدرس / اطلاعات ورود 🔑 (set/not-set only) · محصولات متصل 🛍 » `admin:panel:prods:<sid>` / feature/pricing/username/cfg pages · **اکانت تست 🎁 » `admin:panel:trial:<sid>`** / حذف (soft) / بازگشت به لیست پنل‌ها (same filter/page) / بازگشت به مدیریت پنل‌ها |
| اکانت تست 🎁 (`admin:panel:trial:<sid>`, **OWNER-only** — every trial route; non-OWNER admins get a safe toast, never data; legacy `admin:panel:ts:<sid>` renders the same page) | فعال کردن / غیرفعال کردن » two-step confirm `admin:panel:tren:<sid>` / `admin:panel:trdis:<sid>` (» `…:yes`, انصراف » trial page; enable re-validates config first) / تنظیم مدت (`fe:<sid>:tdm`) · تنظیم حجم (`fe:<sid>:tvm`) / تنظیم اینباندهای تست (`fe:<sid>:tib`, XUI only) · ظرفیت تست (`fe:<sid>:tmc`) / ✅\|❌ غیرفعال‌سازی خودکار بعد از انقضا (`tg:<sid>:tade`) / پیش‌نمایش نام » `admin:panel:trpn:<sid>` · آمار اکانت‌های تست » `admin:panel:trst:<sid>` / بازگشت به جزئیات پنل |
| آمار اکانت‌های تست (`admin:panel:trst:<sid>`, counters/dates only) | بازگشت » `admin:panel:trial:<sid>` |
| روش نام‌گذاری سرویس (`admin:panel:us:<sid>`, naming phase) | روش فعلی (Persian label) + description + نمونه نام ساخته‌شده / تغییر روش نام‌گذاری » selector (`admin:panel:up:<sid>:<0-7>`, Persian labels, back » `admin:panel:us`) / پیش‌نمایش نام‌گذاری » `admin:panel:unp:<sid>` / field edits (متن دلخواه، طول تصادفی، …) / بازگشت |
| روش نام‌گذاری محصول دیگر (`admin:prod:naming:<sid>`, OTHER_PRODUCT only) | 5 policies » `admin:prod:setnp:<sid>:<0-4>` · ویرایش قالب نام‌گذاری *(flow, strict variable registry)* · بازگشت — the delivery reference «شناسه تحویل» then appears on delivery messages, admin manual-order details, user order/history details and «جستجوی سفارش» |

### Other admin sections (unchanged)

- **تیکت‌های پشتیبانی 🎫** — filters » detail » پاسخ ✍️ *(flow)* / بستن ✅.
- **پیام همگانی 📣** — draft *(flow)* » audience » preview » test/start.
- **تنظیمات عمومی ⚙️** — مدیریت متن‌ها ✍️ (templates/buttons list » edit
  *(flows)* / reset). The four wallet template keys are editable here.
  Plus the user menu-keyboard-mode page, the global free-trial page
  «تنظیمات اکانت تست 🎁» and the ops-logging page «تنظیمات گروه لاگ 📝»
  (see the tables below, `docs/user-menu-keyboard-modes.md`,
  `docs/free-trial-admin-management.md` and `docs/telegram-log-group.md`).
- **گزارشات / بکاپ 🛡** — production-backup rework: health, queued
  worker-side backups, file detail/verify/delete, scheduled-backup
  settings (see the tables below and `docs/backup-architecture.md`).

### گزارشات / بکاپ 🛡 (`admin:reports_backup`, production-backup rework)

Health/list/file-detail/restore-help are admin-readable; **every mutating
action (create/download/verify/delete/cleanup/schedule) is OWNER-only**.
Callback data carries only timestamp short ids (`YYYYMMDD-HHMMSS`) and
operation short ids — never raw filenames.

| page | buttons |
| --- | --- |
| landing (`admin:reports_backup`) | وضعیت سیستم 🩺 » `admin:rb:health` / ساخت بکاپ دیتابیس 💾 » `admin:rb:backup` / لیست بکاپ‌ها 🧾 » `admin:rb:list:1` / پاکسازی بکاپ‌های قدیمی 🧹 » `admin:rb:cleanup` / راهنمای Restore ♻️ » `admin:rb:restore_help` / تنظیمات بکاپ خودکار ⏰ » `admin:rb:sched` / بررسی نصب و بروزرسانی 🧪 » `admin:rb:deploy` / بازگشت به منوی ادمین » `admin:menu` |
| وضعیت سیستم 🩺 (`admin:rb:health`, see `docs/system-health.md` — now opens with «نسخه در حال اجرا» + the version-mismatch warning) | به‌روزرسانی 🔄 » `admin:rb:health` / بازگشت » `admin:reports_backup` |
| بررسی نصب و بروزرسانی 🧪 (`admin:rb:deploy`, deployment diagnostics — repo/bot/worker short SHAs, migration completeness, backup-mount access, pg_dump; admin-readable, see `docs/system-health.md`) | اجرای تست بکاپ » `admin:rb:testbk` (**OWNER**) / بروزرسانی 🔄 » `admin:rb:deploy` / بازگشت » `admin:reports_backup` |
| اجرای تست بکاپ (`admin:rb:testbk`, confirm — a REAL verified backup through the worker queue, never a dry run) | تایید و اجرا ✅ » `admin:rb:testbk_yes` (reuses the manual-backup path; lands on the live `admin:rb:op:<opSid>` operation page) / انصراف » `admin:rb:deploy` |
| ساخت بکاپ (`admin:rb:backup`, confirm) | بله، ساخت بکاپ 💾 » `admin:rb:backup_yes` (creates ONE `BackupOperation` + queued job; repeated taps reuse the active operation) / انصراف » `admin:reports_backup` |
| operation status (`admin:rb:op:<opSid>`) | (while active) بروزرسانی وضعیت 🔄 » `admin:rb:op:<opSid>` / (when a file exists) دریافت فایل 📥 » `admin:rb:dl:<sid>` / لیست بکاپ‌ها 🧾 » `admin:rb:list:1` / بازگشت » `admin:reports_backup` |
| لیست بکاپ‌ها 🧾 (`admin:rb:list:<page>`, 10/page) | one per file «💾 {sid} \| {size} \| {verify}» » `admin:rb:file:<sid>` · pagination · بازگشت » `admin:reports_backup` |
| file detail (`admin:rb:file:<sid>` — time, size, type, encryption, verify state, trigger, status) | دریافت فایل 📥 » `admin:rb:dl:<sid>` / بررسی سلامت 🧪 » `admin:rb:verify:<sid>` (queued VERIFY job; legacy/CLI files without an operation row toast «برای این فایل رکورد عملیات وجود ندارد؛ از CLI بررسی کنید.») / حذف بکاپ 🗑 » `admin:rb:del:<sid>` / بازگشت » `admin:rb:list:1` |
| delete step 1 (`admin:rb:del:<sid>`) | ادامه حذف 🗑 » `admin:rb:del2:<sid>` / انصراف » `admin:rb:file:<sid>` |
| delete step 2 — DISTINCT final page (`admin:rb:del2:<sid>`) | بله، حذف نهایی ❗️ » `admin:rb:del_yes:<sid>` / انصراف » `admin:rb:file:<sid>` |
| پاکسازی (`admin:rb:cleanup`, confirm with retention numbers) | بله، پاکسازی 🧹 » `admin:rb:cleanup_yes` (queued worker CLEANUP job) / انصراف » `admin:reports_backup` |
| راهنمای Restore ♻️ (`admin:rb:restore_help`, instructions only — nothing executed) | بازگشت » `admin:reports_backup` |
| تنظیمات بکاپ خودکار ⏰ (`admin:rb:sched` — status, interval, hour UTC, log-group notify, env-managed retention values) | فعال/غیرفعال کردن بکاپ خودکار » `admin:rb:sched:toggle` / هر ۶ ساعت · هر ۱۲ ساعت · روزانه · هفتگی » `admin:rb:sched:int:<6h\|12h\|daily\|weekly>` / تغییر ساعت اجرا 🕒 » `admin:rb:sched:hour` *(flow `rb:sched_hour`, 0–23)* / خاموش/روشن کردن اعلان گروه لاگ » `admin:rb:sched:notify` / بازگشت » `admin:reports_backup` |

### تنظیمات عمومی ⚙️ → تنظیمات گروه لاگ 📝 (log-group wizard + direct numeric-ID phase; namespace `admin:lg` + group-side `lgset:`)

The root page is **state-dependent** (unconfigured vs configured
keyboards). Status page + «بررسی مجدد اتصال ♻️» are admin-readable;
wizard/tests/toggles/disconnect and the **numeric-ID setup** are
**OWNER-only**. Chat ids are always masked. Three converging entry points
bind the group: the **recommended direct numeric-ID flow** (paste the
`-100…` id in the bot's private chat — no in-group step), the wizard's
`?startgroup=zedlog` deep link, and `/setloggroup`; the latter two complete
**inside** the candidate forum supergroup on the explicit in-group
confirmation. See `docs/telegram-log-group.md`.

> **Provisional (numeric-ID handler being finalized in parallel).** The
> routes `admin:lg:id`, `id_confirm`, `id_cancel`, `id_pubok`, `id_retry`,
> `id_cancel_op`, `admin:lg:op:<sid>` and the `lg:chat_id` text flow, plus
> the reworked state-dependent root keyboards (unconfigured: numeric-ID
> entry listed **first**; configured: numeric-ID under «تغییر/افزودن»), are
> the planned scheme from the design; the exact callback strings/labels may
> shift when `log-group-id.handler.ts` lands. The shared services they call
> (`prepareLogGroupConnection` / `createLogGroupSetupAttempt` /
> `confirmLogGroupConnection` / `cancelSetupAttempt`, `attemptShortId` →
> 8-char `<sid>`) and the safe texts are stable.

| page | buttons |
| --- | --- |
| «تنظیمات گروه لاگ 📝» (`admin:lg`, UNCONFIGURED: «وضعیت: تنظیم نشده ❌» + wizard hint) | اتصال گروه لاگ ➕ » `admin:lg:connect` / راهنمای ساخت گروه » `admin:lg:guide` / بررسی مجدد اتصال ♻️ » `admin:lg:recheck` / بازگشت » `admin:general_settings` |
| «تنظیمات گروه لاگ 📝» (`admin:lg`, CONFIGURED: state, group name, masked id, «موضوعات فعال: n از 11», last success/error) | بررسی اتصال 🧪 » `admin:lg:check` (rights check, sends nothing) / ارسال پیام آزمایشی » `admin:lg:test` / ساخت موضوعات پیش‌فرض » `admin:lg:ensure` / همگام‌سازی موضوعات » `admin:lg:sync` / مدیریت موضوعات » `admin:lg:topics` / اتصال با آیدی عددی *(provisional `admin:lg:id`, **OWNER**)* / تغییر گروه لاگ » `admin:lg:connect` / قطع اتصال گروه » `admin:lg:disc` / بازگشت » `admin:general_settings` |
| numeric-ID entry *(provisional `admin:lg:id`, **OWNER**)* → opens the bounded text flow **`lg:chat_id`** (`adminLogGroupSetupDraft`, OWNER-only, cleared on success/cancel/escape). Paste `-100…`; malformed → «آیدی گروه معتبر نیست.\n\nآیدی عددی سوپرگروه باید با -100 شروع شود.» (flow stays open). Valid → probe + shared policy → confirmation preview (or first failing safe message; nothing saved) | *(text flow — no buttons on the prompt itself; a preview or a safe error follows)* |
| public-group warning *(shown only when the target has a public `@username`; recommends a private group)* | ادامه » *(provisional `id_pubok`)* / انصراف » *(provisional `id_cancel`)* |
| confirmation preview *(safe title + masked id + topic count + replacement warning when a different group is bound; creates a `VALIDATED` attempt, binds nothing)* | تایید » *(provisional `id_confirm`)* — re-validates, CAS `VALIDATED→QUEUED` (+ activeSlot), enqueues `log-group-setup-<attemptId>`, lands on the progress page / انصراف » *(provisional `id_cancel`)* |
| setup progress/status *(provisional `admin:lg:op:<sid>`, `<sid>` = 8-char attempt short id; mirrors the backup `admin:rb:op:<sid>` page)* | بروزرسانی 🔄 » `admin:lg:op:<sid>` (while running) / لغو راه‌اندازی » *(provisional `id_cancel_op`)* (preserves active group + history, never deletes topics) / تلاش مجدد » *(provisional `id_retry`, on FAILED)* / بازگشت » `admin:lg` |
| connection wizard (`admin:lg:connect`, **OWNER** — 5-step body; prefixed with the replacement warning when a group is already bound) | افزودن ربات به گروه ➕ » URL `https://t.me/<bot_username>?startgroup=zedlog` / بررسی مجدد اتصال ♻️ » `admin:lg:recheck` / انصراف » `admin:lg` |
| راهنمای ساخت گروه (`admin:lg:guide`, static 6-step help) | بازگشت » `admin:lg` |
| بررسی مجدد اتصال ♻️ (`admin:lg:recheck`, read-only wizard poll — re-verifies rights when bound, then re-renders the state-dependent root) | *(lands on `admin:lg`)* |
| group-side confirmation (sent INSIDE the candidate group after `/setloggroup` or the `/start zedlog` deep link; «این گروه به‌عنوان گروه لاگ ربات ثبت شود؟» + replacement warning when a DIFFERENT group is bound) | تایید اتصال گروه ✅ » `lgset:yes` (re-validates OWNER + environment + presser membership; binds, ensures topics, sends the test, then «بازگشت به ربات» URL button) / انصراف » `lgset:no` |
| همگام‌سازی موضوعات 🔄 (`admin:lg:sync`, read-only report: ready / بدون موضوع / متصل به گروه دیگر) | بازگشت » `admin:lg` |
| مدیریت موضوعات (`admin:lg:topics`, one row per stable topic key) | «✅/❌ {title}» toggle » `admin:lg:tt:<KEY>` · ارسال تست » `admin:lg:tx:<KEY>` (KEY ∈ SYSTEM/ERROR/PAYMENT/ORDER/SERVICE/PANEL/SECURITY/BACKUP/SUPPORT/BROADCAST/AUDIT) / بازگشت » `admin:lg` |
| قطع اتصال (`admin:lg:disc`, confirm «ارسال لاگ‌ها به گروه متوقف می‌شود؛ موضوعات و تاریخچه حذف نمی‌شوند.») | بله، قطع اتصال » `admin:lg:disc_yes` / انصراف » `admin:lg` |

### تنظیمات عمومی ⚙️ → نوع نمایش منوها (menu-keyboard-mode phases)

| page | buttons |
| --- | --- |
| overview (`admin:menu_mode`, shows the CURRENT mode of both menus via `MENU_MODE_LABELS`) | تنظیم منوی کاربران » `admin:menu_mode:user` / تنظیم منوی ادمین » `admin:menu_mode:admin` / بازگشت به تنظیمات عمومی » `admin:general_settings` |
| scope page (`admin:menu_mode:<user\|admin>`, shows «نوع فعلی») | دکمه شیشه‌ای » `admin:menu_mode:ask:<scope>:inline` · دکمه معمولی » `admin:menu_mode:ask:<scope>:reply` / بازگشت » `admin:menu_mode` |
| confirm (`admin:menu_mode:ask:<scope>:<inline\|reply>`; selecting the active mode only toasts «این نوع نمایش از قبل فعال است.») | تایید ✅ » `admin:menu_mode:set:<scope>:<inline\|reply>` / انصراف » `admin:menu_mode:<scope>` |
| apply (`admin:menu_mode:set:<scope>:<inline\|reply>`) | toast «نوع نمایش منوی کاربر/ادمین با موفقیت تغییر کرد ✅» (or the «از قبل فعال» toast) » re-renders the scope page |

In `REPLY` mode the main-menu row labels arrive as **text** (reply
buttons carry no callback data) and are routed by the shared dispatchers
— `apps/bot/src/handlers/admin-menu-actions.ts` first (denies
unauthorized senders of admin labels), then
`apps/bot/src/handlers/user-menu-actions.ts` — to the same section
entries as the inline callbacks.

### تنظیمات عمومی ⚙️ → تنظیمات اکانت تست 🎁 (**OWNER-only**, free-trial-button-visibility fix)

The global free-trial switch + the diagnostics that explain the user
button's visibility (one shared policy with the user menu — see
`docs/free-trial-admin-management.md` for texts and flows):

| page | buttons |
| --- | --- |
| «🎁 تنظیمات اکانت تست رایگان» (`admin:trial_settings`; global status, ready/incomplete panel counts, user-button visibility + exact hidden reason) | فعال کردن تست رایگان » `admin:trial_settings:en` *(while disabled; refuses with zero ready panels)* **or** غیرفعال کردن تست رایگان » `admin:trial_settings:dis` *(while enabled)* / مشاهده پنل‌های آماده » `admin:trial_settings:ready` / مشاهده پنل‌های ناقص » `admin:trial_settings:inc` / کمپین ریست اکانت تست » `admin:trialent:camp:new` / مدیریت سهمیه‌ها و ریست‌ها » `admin:trialent:dash` / بروزرسانی وضعیت ♻️ » `admin:trial_settings` / بازگشت به تنظیمات عمومی » `admin:general_settings` |
| enable/disable confirm (`admin:trial_settings:en` / `…:dis`) | تایید ✅ » `admin:trial_settings:en:yes` / `…:dis:yes` *(re-checks state + readiness, compare-and-set flip)* / انصراف » `admin:trial_settings` |
| «پنل‌های آماده تست ✅» (`admin:trial_settings:ready`; name/type/«مدت تست»/«حجم تست» only) | تنظیمات پنل 🎁 » `admin:panel:trial:<sid>` per panel / بازگشت » `admin:trial_settings` |
| «پنل‌های فعال ولی ناقص ❌» (`admin:trial_settings:inc`; safe «مشکل: …» sentence per panel, no secrets/raw errors) | تنظیمات پنل 🎁 » `admin:panel:trial:<sid>` per panel / بازگشت » `admin:trial_settings` |

### تنظیمات اکانت تست 🎁 → مدیریت سهمیه‌ها و ریست‌ها + کمپین‌ها (**OWNER-only**, trial-entitlement phase; namespace `admin:trialent:`)

| page | buttons |
| --- | --- |
| «مدیریت سهمیه‌ها و ریست‌ها 🎁» (`admin:trialent:dash`; indexed metrics: active grants/users, expiring 7-day window, claims by status, converted services, campaign counts, failed recipients) | جستجوی کاربر » `admin:trialent:search` *(reuses the `admin_users:search` flow)* / کمپین ریست تست » `admin:trialent:camp:new` / کمپین‌ها » `admin:trialent:camps:1` / سهمیه‌های در حال انقضا » `admin:trialent:exp:1` / موارد نیازمند بررسی » `admin:trialent:rev:1` / بروزرسانی ♻️ » `admin:trialent:dash` / بازگشت » `admin:trial_settings` |
| سهمیه‌های در حال انقضا (`admin:trialent:exp:<page>`, ACTIVE grants expiring inside 7 days) · موارد نیازمند بررسی (`admin:trialent:rev:<page>`, MANUAL_REVIEW + PROVISIONING claims older than 15 min) | pagination / بازگشت » `admin:trialent:dash` |
| کمپین‌ها 🎁 (`admin:trialent:camps:<page>`) | one row per campaign (short id · status · date) » `admin:trialent:camp:v:<sid>` · pagination · بازگشت » `admin:trialent:dash` |
| campaign detail (`admin:trialent:camp:v:<sid>`; status + total/granted/skipped/failed/processed counters) | بروزرسانی ♻️ » same / مشاهده موارد ردشده » `admin:trialent:camp:sk:<sid>:1` / مشاهده خطاها » `admin:trialent:camp:fl:<sid>:1` / لغو کمپین » `admin:trialent:camp:cx:<sid>` (»confirm «بله، لغو کمپین» » `…:cx:<sid>:yes`; only DRAFT/PREVIEWED/QUEUED/RUNNING) / کمپین‌ها » `admin:trialent:camps:1` / بازگشت » `admin:trialent:dash` |
| campaign builder («کمپین ریست اکانت تست 🎁», `admin:trialent:camp:new`) | 8 audience buttons » `admin:trialent:camp:aud:<KIND>` *(date flow for REGISTERED_BEFORE/AFTER, telegram-id-list flow for SELECTED_USERS — max 500 lines)* » allowance *(flow)* » expiry: بدون تاریخ انقضا » `admin:trialent:camp:exp:none` · اعتبار برای چند روز » `…:exp:days` *(flow)* » notify: بدون ارسال پیام / ارسال پیام به کاربر » `admin:trialent:camp:notify:no\|yes` » include: رد شدن / شامل شدن کاربران دارای سهمیه » `admin:trialent:camp:inc:no\|yes` » reason *(flow)* » preview |
| campaign preview («🎁 پیش‌نمایش کمپین ریست تست», estimated audience + rules + reason) | شروع کمپین ✅ » `admin:trialent:camp:startask` (final warning » ادامه ✅ » `admin:trialent:camp:typed` » typed-confirmation *(flow: exact `RESET TRIAL`)*) / ویرایش تنظیمات » `admin:trialent:camp:edit` *(cancels the persisted draft, restarts)* / لغو » `admin:trialent:camp:abort` / بازگشت » `admin:trial_settings` |

## Notification & retention engine (feat/notification-retention-engine, Phase 1)

**User** — under «سرویس‌های من»:

| Entry | Routes |
| --- | --- |
| «تنظیمات اعلان‌ها 🔔» (`user:nset:root`) | اعلان‌های خودکار » `user:nset:toggle:cron` / اعلان سرویس‌ها » `user:nset:toggle:svc` / ساعات سکوت » `user:nset:toggle:quiet` / منطقه زمانی » `user:nset:tz` (cycles allowlist) / سقف روزانه » `user:nset:limit` (cycles 1..10) / بازگشت » `CB.USER_SERVICES` |
| جزئیات سرویس → «اعلان‌های این سرویس 🔔» (`user:nsvc:<sid>`) | per-kind three-state toggle » `user:nsvc:tg:<sid>:(expiry\|traffic\|status)` / بازگشت به سرویس » `user:svc:view:<sid>` |

**Notification action buttons** (worker-rendered, `ntf:<shortId>:<action>`):
`s` open → service detail · `r` renew → renewal page (or detail + notice) · `v`
extra-volume → extra-volume page (or detail + notice) · `x` dismiss → strip
keyboard. Owner-scoped resolve + live capability re-validation on every click.

**Admin** — پنل ادمین → تنظیمات عمومی:

| Entry | Routes |
| --- | --- |
| «اعلان‌ها و یادآوری‌ها 🔔» (`admin:ntf`) | فعال/غیرفعال کردن سیستم » `admin:ntf:enable` / `admin:ntf:disable` (OWNER-only; enable behind the activation gate) / toggle rule » `admin:ntf:rule:(expiry\|traffic\|trial)` (OWNER-only) / صفحهٔ قانون سفارش/پرداخت » `admin:ntf:co:(abandoned\|payment)` / بروزرسانی » `admin:ntf` / بازگشت » `CB.ADMIN_GENERAL_SETTINGS` |

## Checkout & payment reminders (feat/checkout-payment-reminders, Phase 2)

Same foundation as Phase 1 — the `ntf:<shortId>:<action>` namespace and the admin
«اعلان‌ها و یادآوری‌ها 🔔» page. Two new rules (category PAYMENT), both OWNER-only
and disabled by default. Reminders navigate a user back into an existing checkout
but never settle, create orders, approve receipts, spend wallet, provision, or
alter reconciliation.

**Checkout notification action buttons** (worker-rendered, `ntf:<shortId>:<action>`):
`c` continue → resume service re-checks LIVE state and hands off to the existing
method-selection surface (never creates a new checkout; falls back to a safe page
if the checkout is settled/expired/under review) · `d` details → owner-scoped
checkout view · `n` stop → suppress THIS checkout's reminders of this kind (strips
the keyboard, one-kind, never the user's global preference). A foreign/expired/
detached notification answers the same safe "این اعلان دیگر معتبر نیست." toast — no
existence reveal.

**Admin** — پنل ادمین → تنظیمات عمومی → «اعلان‌ها و یادآوری‌ها 🔔»:

| Entry | Routes |
| --- | --- |
| «یادآوری سفارش ناقص 🛒» (`admin:ntf:co:abandoned`) | فعال/غیرفعال » `admin:ntf:co:tg:abandoned` (OWNER-only; enable behind the per-rule activation gate) / تنظیم زمان یادآوری اول·دوم·حداکثر تعداد·حداکثر عمر » `admin:ntf:co:e:abandoned:(t1\|t2\|max\|age)` *(flow `admin_ntf_co:cfg`)* / ویرایش متن پیام » `admin:ntf:co:tpl:abandoned` / پیش‌نمایش مخاطبان » `admin:ntf:co:prev:abandoned` / ارسال آزمایشی » `admin:ntf:co:test:abandoned` / بازگشت » `admin:ntf` |
| «یادآوری پرداخت ناموفق 💳» (`admin:ntf:co:payment`) | فعال/غیرفعال » `admin:ntf:co:tg:payment` (OWNER-only; gated) / تنظیم تأخیر·سقف هر پرداخت·سقف روزانه هر سفارش » `admin:ntf:co:e:payment:(delay\|maxpay\|maxday)` *(flow `admin_ntf_co:cfg`)* / ویرایش متن پیام » `admin:ntf:co:tpl:payment` / پیش‌نمایش مخاطبان » `admin:ntf:co:prev:payment` / ارسال آزمایشی » `admin:ntf:co:test:payment` / بازگشت » `admin:ntf` |
