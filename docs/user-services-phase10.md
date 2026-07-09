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
| `user:svc:refresh:<serviceSid>` | Re-reads the row from the **database** and re-renders — answers «اطلاعات از دیتابیس بروزرسانی شد.» Panel sync is a later phase. |
| `user:svc:link:<serviceSid>` | Sends the stored subscription URL |
| `user:svc:configs:<serviceSid>` | Sends the stored config links |

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
change/enable-disable/transfer/edit buttons — later phases.

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

## Intentionally NOT implemented

Renewal, extra volume/time, location change, enable/disable, change
subscription link, change note, transfer, delete, rating, QR generation,
panel usage sync (the refresh button is DB-only), Marzban/XUI API calls,
service search by username, "username is not mine", admin service
management, web panel, mini app.
