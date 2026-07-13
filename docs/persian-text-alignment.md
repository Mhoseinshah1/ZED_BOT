# Persian Text Alignment — Requirement-to-Text Mapping

Source of truth: `ZED_BOT_Master_Requirements_FA.docx` (v1.0) + the approved
text specification for this phase. Storage types: **MT** = MessageTemplate
(operator-editable, DB), **BT** = ButtonText (operator-editable, DB),
**ST** = Setting, **C** = centralized typed Persian constant in code
(fixed). Every MT/BT has a safe in-code Persian fallback derived from the
seed registry (`packages/database/src/seed-data.ts` → `text.service.ts`).
Status: ✅ aligned in this phase · ✳️ already compliant · ⛔ feature not
implemented (text reserved, button hidden — never a dead button).

## U-MENU — main menu, start, navigation

| Req | Expected (final) text | Source | Previous text | Storage | Editable | Status |
|---|---|---|---|---|---|---|
| U-MENU main rows | خرید اشتراک 🔐/تمدید سرویس ♻️ · سرویس‌های من 🛍/کیف پول + شارژ 🏦 · محصولات دیگر 🛍/سفارش‌های من 🧾 · پشتیبانی ☎️ | keyboards/user-main.keyboard.ts | same | BT ×7 | yes | ✳️ |
| U-MENU-001 | start template with {first_name}/{username}/{bot_name}/{sales_status}; missing values remove their lines | menu.handler.ts + `start_text` | «به ربات خوش آمدید.» (static) | MT | yes | ✅ |
| U-MENU-002 | «بازگشت به منوی اصلی» on every level-2/3 page | all handlers | mostly present; services empty-state said «بازگشت به منو» | BT `main_menu` + literals | partial | ✅ |
| U-MENU-003 | «بروزرسانی ♻️» on info pages | wallet/services/ticket views | present | BT `refresh` | yes | ✳️ |
| U-MENU-004 | no dead buttons | all keyboards | placeholder texts said «در فاز بعدی…» | C | — | ✅ (reworded; placeholders answer real handlers) |
| U-MENU-005 | Referral/تست/گردونه/آموزش/تعرفه/نمایندگی hidden | user-main.keyboard.ts | hidden | — | — | ✳️ |
| Nav labels | بازگشت / بازگشت به لیست / بازگشت به منوی اصلی / بازگشت به پنل ادمین / بروزرسانی ♻️ | BT back/back_to_list/main_menu/back_to_admin/refresh | back/main_menu existed; list/admin added to registry | BT | yes | ✅ |

## U-REG — access gates

| Req | Final text | Storage | Previous | Status |
|---|---|---|---|---|
| Maintenance | «ربات در حال بروزرسانی است. لطفاً کمی بعد دوباره تلاش کنید.» | MT `bot_off_text` | «ربات در حال حاضر در دسترس نیست. لطفا بعدا مراجعه کنید.» | ✅ |
| Blocked | «حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید.» | MT `blocked_text` (new) + C fallback | «دسترسی شما به ربات محدود شده است.» (hardcoded) | ✅ |
| Terms | «برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید.» | MT `terms_text` (new) | fallback leaked «(متن قوانین در فاز بعدی تکمیل می‌شود.)» | ✅ |
| Force-join | «برای ادامه، ابتدا در کانال‌های مشخص‌شده عضو شوید.» | MT `force_join_text` (new) | fallback leaked phase note | ✅ |
| Sales lock | «در حال حاضر خرید جدید موقتاً غیرفعال است، اما سرویس‌ها و پشتیبانی در دسترس هستند.» | — | — | ⛔ U-REG-008 (no emergency sales-lock gate exists; text reserved) |

## U-BUY / U-INV — purchase + invoice + discount

| Req | Final text | Storage | Previous | Status |
|---|---|---|---|---|
| U-BUY-001 | «انتخاب پنل / لوکیشن» | C checkout-views | «از کدام پنل می‌خواهید خرید کنید؟» | ✅ |
| U-BUY-002 | «انتخاب دسته‌بندی» | C | «دسته‌بندی مورد نظر را انتخاب کنید.» | ✅ |
| U-BUY-003 | «انتخاب پلن» | C | «پلن مورد نظر را انتخاب کنید.» | ✅ |
| Unavailable | «این محصول در حال حاضر قابل خرید نیست.» | C checkout.handler | «این محصول در دسترس نیست.» | ✅ |
| Config incomplete | «تنظیمات این محصول کامل نیست و امکان خرید آن وجود ندارد.» | — | products are hidden silently by the sellability gate | ⛔ (no distinct render site without logic change; stale clicks answer the unavailable text) |
| U-INV-001/002 | invoice layout «🧾 پیش‌فاکتور شما:» + 🌿/🌐/⏳/🧯/💵/📝/🏦 lines | C checkout-views (`preInvoiceText`) | unlabeled plain lines | ✅ (hardcoded builder; deliberately NOT an MT — it composes typed money/discount fields; documented deferral) |
| U-INV-003 | «💵 قیمت اصلی» / «🎟 تخفیف» / «✅ مبلغ نهایی» | C | «قیمت/مبلغ تخفیف/مبلغ قابل پرداخت» | ✅ |
| U-INV-004 | «⏱ اعتبار پیش‌فاکتور: …» | C (registered view) | «اعتبار تا: …» | ✅ |
| U-INV-005 | «🔎 کد پیگیری: <short id>» | C | missing | ✅ |
| Invoice buttons | «پرداخت / تایید خرید ✅» «ثبت کد تخفیف 🎟» «بازگشت» (+ existing «پرداخت با کیف پول 🏦», «حذف کد تخفیف ❌») | C | «ادامه و انتخاب روش پرداخت ✅» «وارد کردن کد تخفیف 🎁» «بازگشت به محصولات» | ✅ («لغو سفارش» ⛔ — no unpaid-order cancel flow exists; drafts auto-cancel) |
| Expired | «این پیش‌فاکتور منقضی شده است. لطفاً دوباره اقدام کنید.» | C payment-views | tail differed | ✅ |
| Cancel notice | «سفارش پرداخت‌نشده با موفقیت لغو شد.» | — | silent auto-cancel | ⛔ (HISTORY-007 cancel flow unimplemented) |
| Discount prompt | «کد تخفیف را وارد کنید.» | C | same | ✳️ |
| Applied | «کد تخفیف با موفقیت اعمال شد ✅» | C | «کد تخفیف اعمال شد ✅» | ✅ |
| Invalid | «کد تخفیف معتبر نیست.» | C discount.service | same | ✳️ |
| Expired code | «مهلت استفاده از این کد تخفیف به پایان رسیده است.» | C | «کد تخفیف منقضی شده است.» | ✅ |
| Capacity | «ظرفیت استفاده از این کد تخفیف تکمیل شده است.» | C | «سقف استفاده…» | ✅ |
| Per-user max | «شما قبلاً از این کد تخفیف به حداکثر تعداد مجاز استفاده کرده‌اید.» | C | shorter | ✅ |
| Product scope | «این کد تخفیف برای محصول انتخاب‌شده قابل استفاده نیست.» | — | — | ⛔ (product-scoped discount codes not implemented; purpose/group scopes have own Persian texts) |

## PAY / PAY-REC — payment + receipts

| Req | Final text | Storage | Previous | Status |
|---|---|---|---|---|
| Method select | «روش پرداخت را انتخاب کنید:» | C payment-views | same | ✳️ |
| Method labels | DB gateway names (default «کارت‌به‌کارت»); wallet = «پرداخت با کیف پول 🏦» | ST/DB + C | same | ✳️ (unimplemented gateway types answer «این روش پرداخت در حال حاضر در دسترس نیست.» — reworded from phase language) |
| Card-to-card | «برای تکمیل پرداخت، مبلغ {price} تومان را واریز کنید:» + ==== block + «سپس روی «پرداخت کردم» بزنید و رسید را ارسال کنید.» | C payment-views (+ per-gateway DB instructionText) | different layout | ✅ |
| Card buttons | Row1 کپی مبلغ/کپی شماره کارت (copy_text) · Row2 پرداخت کردم ✅/بازگشت (+منوی اصلی) | C | «ارسال رسید 🧾» «بازگشت به روش‌های پرداخت» | ✅ |
| Incomplete info | «اطلاعات روش پرداخت کامل نیست. لطفاً با پشتیبانی تماس بگیرید.» | C | merged into NO_METHODS text | ✅ (where the card account is present but unreadable) |
| Receipt prompt | «لطفاً تصویر یا فایل رسید پرداخت را ارسال کنید.» | C payment.handler | «رسید پرداخت را به صورت عکس، فایل یا متن ارسال کنید.» | ✅ (text receipts still accepted; kind-error explains) |
| Registered | «رسید شما با موفقیت ثبت شد و در انتظار بررسی است.» | C | «…ثبت شد و در انتظار بررسی است ✅» | ✅ |
| Duplicate receipt | «این پرداخت قبلاً رسید دریافت کرده است.» | C payment-method.service | «برای این پیش‌فاکتور قبلاً رسید ثبت شده…» | ✅ |
| MIME/size errors | «فرمت فایل رسید پشتیبانی نمی‌شود.» / «حجم فایل رسید بیشتر از حد مجاز است.» | — | — | ⛔ PAY-REC-005 (no MIME/size validation implemented) |
| Bank tracking code | «کد پیگیری بانکی را وارد کنید.» / «این کد پیگیری قبلاً ثبت شده است.» | — | — | ⛔ PAY-REC-002/004 (no tracking-code capture) |
| Approved | «پرداخت شما تایید شد ✅» (+ per-type details) | C receipt-review.service | «رسید پرداخت شما تایید شد ✅» | ✅ |
| Rejected | «پرداخت شما رد شد.» + «دلیل: {reason}» | C | «رسید پرداخت شما رد شد ❌ / دلیل رد:» | ✅ |

## A-REC — admin receipts

| Req | Final | Previous | Status |
|---|---|---|---|
| تایید پرداخت ✅ / رد پرداخت ❌ | button labels | «تایید رسید ✅ / رد رسید ❌» | ✅ |
| مشاهده رسید و مشخصات 🧾 | label | «ارسال/مشاهده…» | ✅ |
| مدیریت کیف پول کاربر 💰 | label (same callback) | «افزایش موجودی کاربر 💰» | ✅ |
| مدیریت/مسدودسازی کاربر 👤 | label | same | ✳️ |
| حذف یا آرشیو رسید 🗑 | — | — | ⛔ (no delete/archive policy implemented; hidden) |
| بازگشت به لیست / بازگشت به مالی | labels | same | ✳️ |
| «آیا از تایید این پرداخت مطمئن هستید؟» | confirm | «…این رسید…» | ✅ |
| «دلیل رد پرداخت را وارد کنید.» (+limits note) | prompt | «دلیل رد رسید را بنویسید…» | ✅ |
| «این رسید قبلاً بررسی شده است.» | guard | same | ✳️ |

## WALLET / WALLET-VIEW

| Req | Final | Previous | Status |
|---|---|---|---|
| Labels آیدی عددی/نام/نام کاربری/شماره موبایل/تاریخ ثبت‌نام/موجودی/گروه کاربری/تعداد سرویس‌ها/سفارش‌های پرداخت‌نشده/تعداد زیرمجموعه | wallet-views | شناسه عددی تلگرام/شماره تماس/زمان ثبت‌نام/موجودی کیف پول/سفارش‌های در انتظار پرداخت-بررسی/تعداد زیرمجموعه‌ها | ✅ |
| Keyboard rows | افزایش موجودی 💰 · تاریخچه تراکنش‌ها 📋+بروزرسانی ♻️ · بازگشت به منوی اصلی | same (doc right/left order) | ✳️ |
| Top-up prompt | «مبلغ موردنظر برای افزایش موجودی را به تومان وارد کنید.» (MT) | «مبلغ شارژ کیف پول را به تومان وارد کنید.» | ✅ |
| Min/Max | «حداقل/حداکثر مبلغ شارژ X است.» | extra «کیف پول» word | ✅ |
| Empty tx | «هنوز تراکنشی برای کیف پول شما ثبت نشده است.» (MT) | «تراکنشی ثبت نشده است.» | ✅ |
| Insufficient | «موجودی کیف پول شما کافی نیست.» | «موجودی کیف پول کافی نیست.» | ✅ |
| Wallet pay OK | «پرداخت از کیف پول با موفقیت انجام شد ✅» | «پرداخت با کیف پول انجام شد ✅» | ✅ |
| Admin wallet | افزایش/کاهش vocabulary unified («کسر» removed), «دلیل این عملیات را وارد کنید.», «آیا از انجام این تغییر مطمئن هستید؟», «موجودی کاربر با موفقیت افزایش یافت/کاهش یافت ✅», «موجودی کاربر نمی‌تواند منفی شود.» | mixed «کسر», specific confirms | ✅ |

## RENEW / SERVICE-INFO / SERVICE-ACT

| Req | Final | Previous | Status |
|---|---|---|---|
| RENEW prompts | «سرویس موردنظر برای تمدید را انتخاب کنید.» / «بسته تمدید را انتخاب کنید.» / «مقدار حجم اضافه را انتخاب کنید.» / «تعداد روز اضافه را انتخاب کنید.» | variants | ✅ (manual amount entry not implemented → «یا وارد کنید» omitted) |
| Success texts | «سرویس شما با موفقیت تمدید شد ✅» / «حجم اضافه با موفقیت به سرویس شما اضافه شد ✅» / «زمان اضافه با موفقیت به سرویس شما اضافه شد ✅» | same (previous phase) | ✳️ |
| Concurrency | «عملیات دیگری روی این سرویس در حال انجام است…» / «انجام عملیات سرویس موقتاً امکان‌پذیر نیست…» | same | ✳️ |
| SERVICE-INFO labels | وضعیت/نام سرویس/نام محصول/لوکیشن / پنل/ترافیک کل/ترافیک مصرف‌شده/ترافیک باقی‌مانده/تاریخ اتمام/روزهای باقی‌مانده/آخرین اتصال | نام کاربری/پنل+موقعیت/حجم…/انقضا/روز باقی‌مانده | ✅ (لینک اشتراک stays behind its owner-only button — SERVICE-INFO-008) |
| Detail menu rows | doc arrangement, right-first per project convention: refresh · لینک اشتراک 🔗+کانفیگ‌ها 📄 · تغییر لینک 🔄 · تمدید سرویس ♻️+خرید حجم اضافه ➕ · خرید زمان اضافه ⏳ · خاموش/روشن · مشکل دارم · بازگشت به لیست+بازگشت به منوی اصلی | rows 2/4/8 ordered by previous-phase reading | ✅ (QR/یادداشت/انتقال/آموزش slots hidden — unimplemented) |
| Refresh texts | «اطلاعات سرویس بروزرسانی شد ✅» / «بروزرسانی اطلاعات سرویس موقتاً امکان‌پذیر نیست.» / «سرویس در پنل پیدا نشد.» | same (previous phase) | ✳️ |
| Empty state | «هنوز سرویسی برای شما ثبت نشده است.» (MT) | «شما هنوز سرویسی ندارید.» | ✅ |
| Legacy texts | «این سرویس با ساختار قدیمی پنل ساخته شده است.» / «این عملیات برای سرویس‌های قدیمی XUI پشتیبانی نمی‌شود.» | same | ✳️ |
| Toggle | confirms «آیا از غیرفعال/فعال کردن این سرویس مطمئن هستید؟», results «سرویس با موفقیت غیرفعال/فعال شد.», failure «تغییر وضعیت سرویس انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.» | failure text differed | ✅ |
| Subscription | «لینک اشتراک شما:» + code block / «کانفیگ‌های سرویس شما:» / regen confirm+success | emoji-headers | ✅ |

## HISTORY / SUPPORT / OTHER-PRODUCT / STOCK / BROADCAST / BACKUP

| Req | Final | Previous | Status |
|---|---|---|---|
| History menu | همه سفارش‌ها 📋 · خرید اشتراک‌ها 🔐+محصولات دیگر 🛍 · پرداخت‌ها 💳+تراکنش‌های کیف پول 🏦 · بازگشت به منوی اصلی | same (doc right/left) | ✳️ |
| Empty states | «هنوز سفارشی ثبت نکرده‌اید.» / «هنوز پرداختی برای شما ثبت نشده است.» / «هنوز سفارش محصول دیگری ثبت نکرده‌اید.» / «هنوز تراکنشی برای کیف پول شما ثبت نشده است.» (MT ×4) | shorter variants | ✅ |
| Support menu | ایجاد تیکت جدید ➕ · تیکت‌های من 📋 · بازگشت به منوی اصلی | same | ✳️ |
| Support prompts | «موضوع تیکت را وارد کنید. ({min} تا {max} کاراکتر)» / «پیام خود را برای پشتیبانی ارسال کنید. (حداکثر {max} کاراکتر)» / «پاسخ خود را ارسال کنید. (حداکثر {max} کاراکتر)» (MT) | different sentences | ✅ (attachments + preview steps ⛔ SUPPORT-002/003 — unimplemented, no prompts added) |
| Ticket created/closed | «تیکت شما با موفقیت ثبت شد ✅» / «این تیکت بسته شده است و امکان ارسال پاسخ جدید وجود ندارد.» / «تیکت با موفقیت بسته شد.» | shorter | ✅ |
| Other-product statuses | در انتظار اطلاعات کاربر 📝 / در انتظار تحویل ادمین ⏳ / تحویل‌شده ✅ / تکمیل‌شده ✅ / لغوشده ❌ / ناموفق ❌ | «در انتظار اطلاعات شما», «لغو شده» | ✅ |
| Other-product prompts | «اطلاعات موردنیاز برای این سفارش را ارسال کنید:» / «اطلاعات شما با موفقیت ثبت شد و سفارش در انتظار تحویل است.» / «محصول شما با موفقیت تحویل شد ✅» / out-of-stock «موجودی این محصول به پایان رسیده است و سفارش برای تحویل دستی ثبت شد.» | variants | ✅ |
| Stock texts | «هر خط باید شامل یک آیتم باشد.» / «حداکثر {max} آیتم در هر مرحله قابل ثبت است.» / «آیتم‌های تکراری حذف شدند: n» / «… با موفقیت و به‌صورت رمزنگاری‌شده ذخیره شد ✅» / low/out alerts «موجودی این محصول کم شده است.» «موجودی این محصول به پایان رسیده است.» | variants | ✅ |
| Broadcast | «خریداران», «تخمین تعداد مخاطبان», «در انتظار» + existing labels | variants | ✅ (media/schedule hidden — BROADCAST-006/007) |
| Backup | «بکاپ با موفقیت ساخته شد ✅» + existing labels/messages (path-only oversize text, no secrets) | «بکاپ ساخته شد ✅» | ✅ |

## ADMIN / ADMIN-FIN / ADMIN-USER

| Req | Final | Previous | Status |
|---|---|---|---|
| Admin menu | مالی 💎+مدیریت کاربران 👤 · مدیریت محصولات/پلن‌ها 📦+مدیریت پنل‌ها 🖥 · محصولات دیگر / سفارش‌های محصولات دیگر · تیکت‌های پشتیبانی 🎫+پیام همگانی 📣 · تنظیمات عمومی ⚙️+گزارشات / بکاپ 📊 | emojis missing on 3 buttons | ✅ (no root-level XUI buttons; placeholders not rendered) |
| Finance menu | رسیدهای تاییدنشده 💵 · روش‌های پرداخت 💳+تنظیمات کیف پول و پرداخت 🏦 · مدیریت کیف پول کاربران 👤+گزارش مالی 📊 · بازگشت به پنل ادمین | same (doc right/left) | ✳️ |
| User search | «آیدی عددی، نام کاربری، شماره موبایل یا نام کاربر را وارد کنید.» — kept richer existing prompt listing every supported key | existing richer prompt retained + aligned | ✅ (see notes) |
| Not found | «کاربری با این مشخصات پیدا نشد.» | «کاربری پیدا نشد.» | ✅ |
| Block confirm/result | «آیا از مسدود کردن این کاربر مطمئن هستید؟» / «کاربر با موفقیت مسدود شد.» / «کاربر با موفقیت فعال شد.» | variants | ✅ |
| Internal note | «یادداشت داخلی» | — | ⛔ ADMIN-USER-006 (feature not implemented) |
| Text editor | «متن با موفقیت بروزرسانی شد ✅» / «متن به مقدار پیش‌فرض بازنشانی شد ✅» / «این متن قابل ویرایش نیست. 🔒» / length-range error / «متغیر استفاده‌شده در این قالب معتبر نیست.» (new variable gate) | variants; no variable validation | ✅ |
| Panel/product/XUI/Marzban labels | per doc §25/§26 — existing Persian labels verified (تست اتصال، قابلیت‌ها، روش احراز هویت، توکن API، آماده ساخت سرویس، …); XUI per-op capability list per lifecycle phase | present | ✳️ |
| OWNER-only | «این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.» | English-heavy | ✅ |

## Template variable registry (TEXT-007)

Every MessageTemplate row now carries its explicit `allowedVariables`
(seeded from `seed-data.ts`); admin edits are validated
(`template-variables.ts`): unknown variables are rejected with
«متغیر استفاده‌شده در این قالب معتبر نیست.», and secret-shaped names
(token/password/cookie/secret/credential/database_url/file_id/
stock_content/api_key) are rejected unconditionally. Rendering never
evaluates secrets — variables are passed explicitly per call site.
`start_text`: first_name, username (optional — line removed when absent),
bot_name, sales_status. Support prompts: min/max.

## Seed behavior (§35)

`packages/database/src/seed.ts`: create-missing + **default refresh** —
when the registry default changes, `defaultContent`/`defaultText` (and
title/variables) are refreshed so admin «reset to default» returns the
approved copy; `currentContent`/`currentText` moves along ONLY when the
operator never customized it (current === old default). Customized
production values are never overwritten. The admin text editor provides
per-item reset; `clearTextCache()` runs on every edit/reset.

## Known remaining gaps (unimplemented features — texts reserved, hidden)

- U-REG-008 emergency sales lock (+ its user text)
- U-BUY-008 / HISTORY-007 unpaid-order cancellation (+ success text)
- PAY-REC-002/004 bank tracking code, PAY-REC-005 MIME/size receipt validation
- A-REC receipt delete/archive
- Product-scoped discount codes
- SUPPORT-002/003 ticket attachments + preview step
- ADMIN-USER-006 internal note
- QR Code, service note editing, service transfer, tutorials, auto-renew
- Jalali (شمسی) date rendering — dates remain Gregorian UTC (formatting change out of scope for this text phase)
