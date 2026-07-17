# Telegram operational log group

Operational events are delivered into one operator-owned Telegram
supergroup, split across **forum topics** — one per stable topic key. The
bot manages the binding and the topics; the actual log delivery is the
worker's job through the `telegram-operational-logs` queue (see
[operational-logging.md](operational-logging.md)).

Code: `apps/bot/src/handlers/admin-settings/log-group.handler.ts` (admin
page + connection wizard),
`apps/bot/src/handlers/admin-settings/log-group-setup.handler.ts`
(group-side completion), `apps/bot/src/services/log-group.service.ts`;
topic keys/titles and the `zedlog` deep-link payload in
`packages/shared/src/ops.ts`.

## Operator setup flow (connection wizard)

The binding starts from the admin page and **completes inside the
candidate group** with an explicit confirmation — nothing binds
instantly. Two equivalent group-side entry points exist:

1. **The wizard (recommended).** On the admin page press «اتصال گروه لاگ
   ➕» (`admin:lg:connect`, OWNER-only). The wizard page shows the exact
   five steps:

   > ۱. یک سوپرگروه خصوصی بسازید.
   > ۲. قابلیت موضوعات یا Topics را فعال کنید.
   > ۳. ربات را با دسترسی ارسال پیام و مدیریت موضوعات، مدیر گروه کنید.
   > ۴. دکمه زیر را بزنید و گروه را انتخاب کنید.
   > ۵. داخل گروه، اتصال را تایید کنید.

   and a URL button «افزودن ربات به گروه ➕» pointing at
   `https://t.me/<bot_username>?startgroup=zedlog` — the username comes
   from the bot's live identity (`ctx.me.username`), never hardcoded, and
   the payload is `LOG_GROUP_STARTGROUP_PAYLOAD` (`"zedlog"`). Telegram
   adds the bot to the chosen group and posts `/start zedlog` there,
   which the group-side handler turns into the confirmation prompt.
   (`/start` is intercepted **only** in group chats and only for this
   exact payload; private-chat `/start` and any other payload fall
   through to the generic start handler.)
2. **The command.** Send `/setloggroup` **inside** the candidate group —
   it lands on the same confirmation prompt.

Both entries validate the sender and the whole environment first and
answer with a safe Persian line on each failure:

| Check | Failure text |
| --- | --- |
| Sender is an active OWNER admin | «این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.» |
| Sent inside a supergroup | «این دستور باید داخل گروه لاگ اجرا شود.» |
| Topics enabled (`is_forum`) | «قابلیت موضوعات گروه فعال نیست. ابتدا Topics را در تنظیمات گروه فعال کنید.» |
| Bot is an administrator | «ربات باید در این گروه مدیر باشد.» |
| Bot has `can_manage_topics` | «دسترسی ارسال پیام یا مدیریت موضوعات کامل نیست.» |
| (confirm press only) presser is still a member of this group | «برای تایید اتصال باید عضو همین گروه باشید.» |

When everything checks out, the prompt «این گروه به‌عنوان گروه لاگ ربات
ثبت شود؟» appears with «تایید اتصال گروه ✅» (`lgset:yes`) / «انصراف»
(`lgset:no`). The binding happens **only** on the explicit confirm press,
which re-validates everything again (OWNER, environment, presser
membership) because the prompt may be stale or forwarded. On success the
binding is saved (Settings `log_group_chat_id` + `log_group_title`), the
default forum topics are created idempotently, a test message is sent, a
`log_group.changed` SECURITY ops log **and** an `AuditLog` row
(`log_group_connected`) are written, and the group receives «این گروه
به‌عنوان گروه لاگ ربات ثبت شد ✅» plus created/existing/failed topic
counts and the test result, with a «بازگشت به ربات» URL button back to
the bot's private chat. «انصراف» shows «اتصال گروه لاگ لغو شد.» (a
non-admin pressing it only clears the spinner).

The whole action is **idempotent**: a repeated confirm re-binds the same
group, topic creation adds zero new topics and the success message is
simply shown again.

**Replacing an existing group:** when a *different* group is already
bound, both the wizard page («تغییر گروه لاگ» reaches the same page —
warning «با تایید گروه جدید، گروه فعلی جایگزین می‌شود.») and the
group-side prompt («با تایید، گروه فعلی جایگزین می‌شود.») show the current
group's name and masked id, and pressing «تایید اتصال گروه ✅» **is** the
replacement consent; no separate confirmation step exists. (The
pre-wizard `admin:lg:rep` / `admin:lg:rep_no` routes are gone.)

After confirming inside the group, go back to the bot and press «بررسی
مجدد اتصال ♻️» (`admin:lg:recheck`) — it re-reads the binding, re-verifies
the bot's rights when configured, and lands on the state-dependent status
page, so the OWNER sees the configured page as soon as the group-side
confirmation completes.

## Admin page — «تنظیمات گروه لاگ 📝»

Path: پنل مدیریت → تنظیمات عمومی ⚙️ → **تنظیمات گروه لاگ 📝**
(`admin:lg`). The page is **state-dependent**: an unconfigured binding
only offers the wizard/guide/recheck actions; a configured one offers the
full toolset. The read-only pages (status, guide, «بررسی مجدد اتصال ♻️»,
«همگام‌سازی موضوعات», the topics list) are admin-readable; the wizard,
tests, topic toggles, disconnect — and «بررسی اتصال 🧪», which is
read-only but OWNER-gated in code — are OWNER-only. Chat ids are always
**masked** (first 4 + last 2 digits) and raw Telegram API descriptions
never reach the admin — failures are classified into safe Persian lines.

**Unconfigured** («وضعیت: تنظیم نشده ❌» + «برای اتصال، از «اتصال گروه
لاگ ➕» استفاده کنید یا دستور /setloggroup را داخل گروه موردنظر
بفرستید.»):

| Button | Callback | Behavior |
| --- | --- | --- |
| اتصال گروه لاگ ➕ | `admin:lg:connect` | The connection wizard (OWNER-only): steps + the `?startgroup=zedlog` URL button |
| راهنمای ساخت گروه | `admin:lg:guide` | Static six-step help for building a wizard-ready group (supergroup, Topics, admin rights, wizard button or `/setloggroup`, in-group confirm) |
| بررسی مجدد اتصال ♻️ | `admin:lg:recheck` | Re-reads the binding state (and re-verifies rights when configured), then re-renders the state-dependent page; admin-readable |
| بازگشت | `admin:general_settings` | — |

**Configured** («وضعیت: متصل ✅» + group name, masked id, «موضوعات فعال:
n از m», last success, last error):

| Button | Callback | Behavior |
| --- | --- | --- |
| بررسی اتصال 🧪 | `admin:lg:check` | Verifies the binding + the bot's admin rights **without sending anything** into the group (OWNER-gated in code) |
| ارسال پیام آزمایشی | `admin:lg:test` | Sends the standard test line to the SYSTEM topic («پیام آزمایشی گروه لاگ با موفقیت ارسال شد ✅») |
| ساخت موضوعات پیش‌فرض | `admin:lg:ensure` | Idempotently ensures every stable key has a `LogTopic` row AND a real forum topic in the bound group (existing bindings skipped, missing/mismatched ones recreated) |
| همگام‌سازی موضوعات | `admin:lg:sync` | Read-only reconciliation report: ready / بدون موضوع (missing) / متصل به گروه دیگر (mismatched) |
| مدیریت موضوعات | `admin:lg:topics` | Per-topic list: first button toggles delivery (`admin:lg:tt:<KEY>`), «ارسال تست» sends a per-topic test (`admin:lg:tx:<KEY>`) |
| تغییر گروه لاگ | `admin:lg:connect` | The same connection wizard, prefixed with the replacement warning for the current group |
| قطع اتصال گروه | `admin:lg:disc` → `admin:lg:disc_yes` | Disconnect, with confirmation |
| بازگشت | `admin:general_settings` | — |

The status page shows: connection state, group name, masked id, «موضوعات
فعال: n از 11», last successful delivery time and the last delivery error
(safe code + time) from `SystemLogDelivery`.

## Topic keys

Behavior binds to the **stable English keys** — titles are display-only
and operator-editable (rename the forum topic freely; delivery follows the
stored `topicId`, not the name). Defaults:

| Key | Default Persian title | Current emitters |
| --- | --- | --- |
| `SYSTEM` | سیستم | bot start/stop |
| `ERROR` | خطاها | *reserved — no emitter yet* |
| `PAYMENT` | پرداخت‌ها | settlements, duplicate-success cases, receipt approve/reject |
| `ORDER` | سفارش‌ها | provisioning completed/failed |
| `SERVICE` | سرویس‌ها | service operations completed/failed |
| `PANEL` | پنل‌ها | panel connection failures |
| `SECURITY` | امنیت | admin-access denials, log-group changes |
| `BACKUP` | بکاپ‌ها | the worker's whole backup lifecycle |
| `SUPPORT` | پشتیبانی | *reserved — no emitter yet* |
| `BROADCAST` | پیام همگانی | *reserved — no emitter yet* |
| `AUDIT` | گزارش حسابرسی | manual wallet adjustments, backup deletions |

Full event → topic mapping: [operational-logging.md](operational-logging.md).

**Disabling a topic** («مدیریت موضوعات») stops only the Telegram delivery
for that key — the `SystemLog` rows keep being written, as the page itself
states: «غیرفعال کردن فقط ارسال را متوقف می‌کند؛ لاگ‌ها همچنان ذخیره
می‌شوند.» Deliveries for a disabled topic are marked `SKIPPED
topic-disabled`.

## Disconnect semantics

«قطع اتصال گروه» (confirmation: «ارسال لاگ‌ها به گروه متوقف می‌شود؛
موضوعات و تاریخچه حذف نمی‌شوند. ادامه می‌دهید؟») deletes only the two
Settings (`log_group_chat_id`, `log_group_title`):

- `LogTopic` rows, their `topicId` bindings and the delivery history stay
  untouched — re-binding the **same** group later resumes without topic
  recreation.
- New deliveries are marked `SKIPPED log-group-unset` (bot-side
  `writeSystemLog` stops creating delivery rows entirely while unset).
- The disconnect itself is recorded as a `log_group.changed` SECURITY ops
  log and via the local logger.

## Failure classification

Telegram errors during setup/tests collapse to safe Persian lines
(`classifyTelegramError`): rate limit 429, «گروه پیدا نشد…», «ربات از گروه
حذف شده است.», «ربات باید در این گروه مدیر باشد…», «موضوع (تاپیک)
موردنظر وجود ندارد یا بسته شده است. «ساخت موضوعات پیش‌فرض» را اجرا
کنید.», «قابلیت موضوعات (Topics) گروه فعال نیست.», plus generic
fallbacks. During real (worker-side) delivery, permanent errors
(`forbidden`, `chat-not-found`, `topic-missing`) dead-letter immediately —
after fixing the group, deleted topics are healed with «ساخت موضوعات
پیش‌فرض».

## Notes

- Test messages are sent by the **bot** process (grammY); real log
  deliveries are sent only by the **worker**, so a stopped worker means
  logs accumulate as `PENDING` deliveries even though tests succeed — see
  the limitations in [operational-logging.md](operational-logging.md).
- Per-topic mappings can outlive the global binding: delivery resolves the
  chat from the topic's own `telegramChatId` first, falling back to the
  global `log_group_chat_id` Setting.
