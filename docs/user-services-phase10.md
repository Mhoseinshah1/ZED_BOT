# ZED_BOT "My Services" (Phase 10)

Phase 10 wires «سرویس‌های من 🛍» to a real, strictly **read-only** view over
the `Service` rows Phase 9 provisioning created. **No panel API calls, no
Service/Order/wallet mutations** — the bot only renders what is already
stored in the database.

Source: `apps/bot/src/handlers/user-services/{services.handler,service-views}.ts`,
`apps/bot/src/services/user-services.service.ts`.

## Callbacks

| Callback | Action |
| --- | --- |
| `user:services` | Entry (the existing main-menu button/`ButtonText` key `my_services`; only this placeholder route was replaced) |
| `user:svc:list:<page>` | Paginated list (5 per page) |
| `user:svc:view:<serviceSid>` | Service detail |
| `user:svc:refresh:<serviceSid>` | ~~DB-only re-read~~ **Phase 11:** now syncs from the panel (read-only) and re-renders — see `docs/service-sync-phase11.md`. List/detail remain read-only for user actions. |
| `user:svc:link:<serviceSid>` | Sends the stored subscription URL |
| `user:svc:configs:<serviceSid>` | Sends the stored config links |
| `user:svc:disable:<serviceSid>[:yes]` | **Phase 18:** disable confirmation / execution — `docs/service-toggle-phase18.md` |
| `user:svc:enable:<serviceSid>[:yes]` | **Phase 18:** enable confirmation / execution — `docs/service-toggle-phase18.md` |

`<serviceSid>` is the 8-char uuid prefix (`serviceShortId`), resolved with
`startsWith` **scoped to the owner's userId** — unknown, ambiguous, deleted
or foreign ids all answer «مورد یافت نشد.» indistinguishably.

## List behavior

Services `where userId = ctx.dbUser.id AND deletedAt IS NULL AND status !=
DELETED`, newest first, 5 per page with «قبلی/بعدی». Empty state: «شما هنوز
سرویسی ندارید.» plus the buy button (ButtonText `buy_subscription` →
`user:buy`) and «بازگشت به منو». Each service button shows
`<statusEmoji> <productNameSnapshot|username> | <remaining days|نامحدود> |
<remaining GB|نامحدود>`.

## Detail fields (stored DB values only)

وضعیت (label map: ACTIVE فعال ✅ / DISABLED غیرفعال ⏸ / EXPIRED منقضی ⌛ /
LIMITED اتمام حجم 📦 / FAILED ناموفق ❌ / CREATING در حال ساخت ⏳ / DELETED
حذف‌شده 🗑), نام سرویس, نام کاربری (`<code>`), پنل (`panelNameSnapshot`),
موقعیت (Persian label), حجم کل / مصرف‌شده / باقی‌مانده (bytes → GB, max 2
decimals; `volumeBytes = 0` = نامحدود, and remaining is نامحدود too), مدت
(`durationDays`, 0 = نامحدود), شروع, انقضا (null = نامحدود), روز باقی‌مانده
(ceil, 0 when passed), آخرین اتصال (only when set), تاریخ ساخت. Missing
dates render as `-`. `note`, `failureReason` and any admin/internal fields
are **never** shown.

Buttons: «بروزرسانی اطلاعات ♻️», «لینک اشتراک 🔗» (only when a
`subscriptionUrl` is stored), «کانفیگ‌ها 📄» (only when non-empty), «بازگشت
به لیست», «بازگشت به منو». No renew/extra volume/extra time/location
change/transfer/edit buttons — later phases. **Phase 18:** the detail page
additionally shows ONE toggle button when eligible — «خاموش کردن سرویس ⏸»
(ACTIVE/LIMITED + panel ACTIVE) or «روشن کردن سرویس ▶️» (DISABLED + panel
ACTIVE + not expired) — see `docs/service-toggle-phase18.md`. Everything
else on the page stays read-only.

## Link / config display

Owner-only. The subscription URL and each config link are sent inside
`<code>` (tap-to-copy), HTML-escaped. Missing link → «لینک اشتراک برای این
سرویس ثبت نشده است.»; no configs → «کانفیگی برای این سرویس ثبت نشده است.»
Config output is capped at 10 with «+N کانفیگ دیگر نمایش داده نشد.»;
`configLinks` is read defensively (strings only — malformed Json entries are
ignored, raw Json is never printed). Links/configs are never logged.

## Security

Every route requires `ctx.dbUser` (behind the user access gates) and
resolves the service with the userId-scoped lookup, so
`service.userId === ctx.dbUser.id` always holds; another user's service id
answers «مورد یافت نشد.». No panel credentials, raw panel responses or
internal fields ever reach the user.

> **Phase 16/17 note:** buying extra volume/«خرید زمان اضافه ⏳» for a
> service lives under the main menu (`docs/extra-volume-phase16.md`,
> `docs/extra-time-phase17.md`); the service detail view itself stays
> read-only.

## Intentionally NOT implemented

Renewal, extra volume/time, location change, change subscription link,
change note, transfer, delete, rating, QR generation, service search by
username, "username is not mine", admin service management, web panel, mini
app. (Panel usage sync for the refresh button — DB-only in Phase 10 —
arrived in Phase 11: `docs/service-sync-phase11.md`; the user
enable/disable toggle arrived in Phase 18:
`docs/service-toggle-phase18.md`.)
