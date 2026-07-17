# Telegram operational log group

Operational events are delivered into one operator-owned Telegram
supergroup, split across **forum topics** — one per stable topic key. The
bot manages the binding and the topics; the actual log delivery is the
worker's job through the `telegram-operational-logs` queue (see
[operational-logging.md](operational-logging.md)).

Code: `apps/bot/src/handlers/admin-settings/log-group.handler.ts`,
`apps/bot/src/services/log-group.service.ts`; topic keys/titles in
`packages/shared/src/ops.ts`.

## Operator setup flow

1. Create (or pick) a **supergroup** and enable **Topics** (forum mode) in
   the group settings.
2. Add the bot to the group and promote it to **administrator** with the
   **Manage topics** right (`can_manage_topics`).
3. As the **OWNER** admin, send `/setloggroup` **inside that group**.

The command validates the whole environment before saving and answers with
a safe Persian line on each failure:

| Check | Failure text |
| --- | --- |
| Sent inside a supergroup | «این دستور باید داخل گروه لاگ اجرا شود.» |
| Topics enabled (`is_forum`) | «قابلیت موضوعات گروه فعال نیست. ابتدا Topics را در تنظیمات گروه فعال کنید.» |
| Bot is an administrator | «ربات باید در این گروه مدیر باشد.» |
| Bot has `can_manage_topics` | «دسترسی ارسال پیام یا مدیریت موضوعات کامل نیست.» |
| Sender is OWNER | «این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.» |

On success the binding is saved (Settings `log_group_chat_id` +
`log_group_title`), the default forum topics are created idempotently, a
`log_group.changed` SECURITY ops log is written, and the group receives
«این گروه به‌عنوان گروه لاگ ربات ثبت شد ✅» plus created/failed topic
counts.

**Replacing an existing group:** if a *different* group is already bound,
the command asks for explicit confirmation inside the new group
(«تایید جایگزینی ✅» → `admin:lg:rep`, «انصراف» → `admin:lg:rep_no`); the
confirmation re-validates everything, so a stale or forwarded button cannot
bind an invalid chat.

## Admin page — «تنظیمات گروه لاگ 📝»

Path: پنل مدیریت → تنظیمات عمومی ⚙️ → **تنظیمات گروه لاگ 📝**
(`admin:lg`). The status page is admin-readable; every mutating action is
OWNER-only. Chat ids are always **masked** (first 4 + last 2 digits) and
raw Telegram API descriptions never reach the admin — failures are
classified into safe Persian lines.

| Button | Callback | Behavior |
| --- | --- | --- |
| بررسی اتصال 🧪 | `admin:lg:check` | Verifies the binding + the bot's admin rights **without sending anything** into the group |
| ارسال پیام آزمایشی | `admin:lg:test` | Sends the standard test line to the SYSTEM topic («پیام آزمایشی گروه لاگ با موفقیت ارسال شد ✅») |
| ساخت موضوعات پیش‌فرض | `admin:lg:ensure` | Idempotently ensures every stable key has a `LogTopic` row AND a real forum topic in the bound group (existing bindings skipped, missing/mismatched ones recreated) |
| همگام‌سازی موضوعات | `admin:lg:sync` | Read-only reconciliation report: ready / بدون موضوع (missing) / متصل به گروه دیگر (mismatched) |
| مدیریت موضوعات | `admin:lg:topics` | Per-topic list: first button toggles delivery (`admin:lg:tt:<KEY>`), «ارسال تست» sends a per-topic test (`admin:lg:tx:<KEY>`) |
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
