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

The **direct numeric chat-ID setup** (recommended, below) adds a shared
validation/lifecycle layer that all three entry points converge on:
`packages/shared/src/log-group-target.ts` (numeric-id normalization + the
one acceptance policy + the safe Persian error messages),
`apps/bot/src/services/log-group-connection.service.ts` (probe / prepare /
create-attempt / confirm / cancel / the atomic activation), the durable
worker processor `apps/worker/src/log-group-setup.ts`
(`PROVISION_LOG_GROUP`) with its fetch-based
`createTelegramForumTopic` (`apps/worker/src/telegram.ts`), and the
`LogGroupSetupAttempt` row (`packages/database/prisma/schema.prisma`,
migration `20260718000000_direct_log_group_id_setup`). The numeric-ID
admin UI itself lives in
`apps/bot/src/handlers/admin-settings/log-group.handler.ts` (reworked
state-dependent keyboards) + a dedicated `log-group-id.handler.ts` numeric
input/preview/progress handler.

## Direct numeric chat-ID setup (recommended)

The fastest, most reliable way to bind the log group: paste the group's
numeric `-100…` chat id into the bot once, and everything after —
validation, the eleven default forum topics, a direct test send and the
atomic switch-over — runs on a **durable background operation** so it
survives a worker restart and never half-binds. Unlike the wizard, you do
not have to enter the group and press a button there; you drive the whole
flow from the bot's private chat. `/setloggroup` and the start-group
wizard both **remain** as equivalent fallbacks (see below) — all three
share the same validation policy and the same atomic activation.

### 1. Get the group's numeric id (`-100…`)

Build a **private forum supergroup** (Topics enabled) and get its numeric
chat id, which always starts with `-100`. Any of:

- Add the bot, then read the id from a group-info bot, or forward any
  message from the group to a "userinfo"/"get-id" bot.
- Open the group's invite/message link and read the internal id from it.
- Any admin tool that reports the raw `chat_id`.

The input box is forgiving: Persian (`۰-۹`) and Arabic (`٠-٩`) digits are
folded to Latin, Unicode minus look-alikes become `-`, and surrounding
whitespace / zero-width / bidi marks are stripped
(`normalizeChatIdInput`). Only a value matching `^-100[0-9]{6,20}$`
(after normalization, and ≤ 64 characters raw) is accepted; usernames,
`t.me/…` links, invite links, positive ids, decimals and scientific
notation are rejected. The id is always kept as a **string** — it is never
`Number()`-converted (a 64-bit id would lose precision as a float).

### 2. Prerequisite bot permissions

Before entering the id, the group must satisfy **all** of:

- The group is a **supergroup** with **Topics / Forum mode enabled**.
- The **bot is a member** of the group.
- The **bot is an administrator** (or creator) of the group.
- The bot admin right **Manage Topics** (`can_manage_topics`) is on.
- The **main OWNER** admin of the bot is also a member of the group.

These are exactly what validation checks, in this order (see below).

### 3. The numeric-ID entry flow

`input → validation → (public-group warning) → confirmation preview →
provisioning progress → active`

1. **Input.** From «تنظیمات گروه لاگ 📝» choose the numeric-ID entry
   («اتصال با آیدی عددی», provisional route `admin:lg:id`, OWNER-only).
   The bot opens a bounded text flow (`lg:chat_id`) and you paste the
   `-100…` id. A malformed id is rejected immediately with «آیدی گروه
   معتبر نیست.\n\nآیدی عددی سوپرگروه باید با -100 شروع شود.» and the flow
   stays open for a retry.
2. **Validation.** The bot **probes** Telegram
   (`getChat` + two `getChatMember` calls) and runs the shared acceptance
   policy (`evaluateLogGroupTarget`). The first unmet requirement is
   reported as a safe Persian line (table below); nothing is persisted.
3. **Public-group warning (optional).** If the target has a public
   `@username`, an extra confirmation is shown recommending a **private**
   group (a public log group leaks operational events to anyone who finds
   it); proceeding requires an explicit acknowledgement (provisional route
   `id_pubok`).
4. **Confirmation preview.** On success the bot shows the group's safe
   title, its **masked** id (`maskChatId` — first 4 + last 2 digits) and
   the number of default topics that will be created, plus — when a
   *different* group is already bound — a replacement warning naming the
   current group. This preview creates a **`VALIDATED`** setup attempt but
   binds nothing. Press confirm (provisional route `id_confirm`) or cancel
   (`id_cancel`).
5. **Provisioning progress.** Confirming re-validates the group, claims
   the single active-setup slot (`VALIDATED → QUEUED`) and enqueues the
   worker job; the bot answers instantly and shows a live progress page
   (provisional route `admin:lg:op:<sid>`, `<sid>` = the attempt's 8-char
   short id) that you refresh. The worker creates the topics one at a
   time, sends a direct test («پیام آزمایشی راه‌اندازی گروه لاگ ✅») and
   activates the group. You can cancel a running setup from this page
   (`id_cancel_op`); a failed setup offers a retry (`id_retry`).
6. **Active.** When activation completes the worker emits the normal
   queued `log_group.connected` event
   («گروه لاگ با موفقیت متصل و فعال شد ✅»), which travels the **same**
   delivery pipeline as every operational log and thus self-verifies the
   whole chain end to end. The progress page then shows success
   (spec text «گروه لاگ با موفقیت راه‌اندازی شد ✅» + the topic count). If
   the group is bound but that queued test has not yet been confirmed
   delivered, the page shows «گروه متصل شد، اما ارسال آزمایشی از صف هنوز
   تایید نشده است ⚠️» (the worker may be down — deliveries are the
   worker's job).

> The admin-UI callback routes and button labels above (`admin:lg:id`,
> `id_confirm`, `id_cancel`, `id_pubok`, `id_retry`, `id_cancel_op`,
> `admin:lg:op:<sid>`, the `lg:chat_id` text flow) are **provisional** —
> the numeric-ID handler is being finalized in parallel; the shared
> service functions and safe texts they call are stable. See
> [navigation-map.md](navigation-map.md).

### Validation sequence and safe error messages

Checked strictly in order — the **first** failure is the one reported
(`evaluateLogGroupTarget`, `LOG_GROUP_SAFE_MESSAGES`, both verbatim from
`packages/shared/src/log-group-target.ts`):

| Order | Check | `safeCode` | Message shown |
| --- | --- | --- | --- |
| 1 | `getChat` succeeded (group exists, bot can see it) | `NOT_FOUND` | «گروه پیدا نشد.\n\nمطمئن شوید آیدی صحیح است و ربات داخل گروه حضور دارد.» |
| 2 | Chat type is `supergroup` | `NOT_SUPERGROUP` | «گروه انتخاب‌شده سوپرگروه نیست.» |
| 3 | Topics/Forum enabled (`is_forum`) | `TOPICS_DISABLED` | «قابلیت موضوعات گروه فعال نیست.\n\nابتدا Topics را در تنظیمات گروه فعال کنید.» |
| 4 | Bot is a member (status not left/kicked/unknown) | `BOT_NOT_MEMBER` | «ربات داخل این گروه عضو نیست.\n\nابتدا ربات را به گروه اضافه کنید.» |
| 5 | Bot is `administrator` (or `creator`) | `BOT_NOT_ADMIN` | «ربات باید در این گروه مدیر باشد.» |
| 6 | Bot has `can_manage_topics` | `MISSING_TOPIC_PERMISSION` | «دسترسی مدیریت موضوعات برای ربات فعال نیست.» |
| 7 | Bot send not explicitly denied | `SEND_UNAVAILABLE` | «ربات اجازه ارسال پیام در این گروه را ندارد.» |
| 8 | The bot OWNER is a member of the group | `OWNER_NOT_MEMBER` | «مدیر اصلی ربات باید عضو گروه انتخاب‌شده باشد.» |

The probe never surfaces raw Telegram payloads: a "chat not found"
`getChat` failure becomes `found:false` (→ `NOT_FOUND`), and a
bot-membership lookup failure leaves `botStatus` null (→ `BOT_NOT_MEMBER`).
For supergroups Telegram exposes no per-admin "can send" flag, so send is
treated as allowed unless an explicit deny is observed (a restricted
member with `can_post_messages:false`); administrator status honestly
implies send rights.

### Private-group recommendation

Use a **private** supergroup. Operational logs contain payment, order,
service, security and audit events; a public group with a `@username`
exposes them to anyone who finds the group, so validation flags a public
target and asks for an explicit extra confirmation before continuing.

### How this maps to the durable operation

Everything after "confirm" is one **persistent `LogGroupSetupAttempt`**
row driving a worker job — the full lifecycle (VALIDATED → QUEUED →
PROVISIONING → TESTING → ACTIVE / FAILED / CANCELLED), the per-topic
durable resume, the **atomic activation trust boundary** (the currently
active group is never overwritten until the staged group is fully
provisioned *and* the direct test send succeeds, so a failed setup leaves
the previous group working untouched) and the queued self-verification are
documented in [operational-logging.md](operational-logging.md); the queue,
job options and lock in [worker-queues.md](worker-queues.md); the row's
invariants in [database-invariants.md](database-invariants.md).

### Flow diagram

```
 OWNER pastes -100… id
        │
        ▼
  normalizeChatIdInput ──✗──► «آیدی گروه معتبر نیست…» (retry, nothing saved)
        │ ok (string, never Number())
        ▼
  probe + evaluateLogGroupTarget ──✗──► first failing safe message (nothing saved)
        │ ok
        ▼
  (public @username?) ──► extra "prefer a private group" confirm
        │
        ▼
  confirmation preview  ── creates VALIDATED attempt (masked id + topic count)
        │ confirm
        ▼
  CAS VALIDATED→QUEUED (+ activeSlot=1) ── enqueue log-group-setup-<attemptId>
        │                                    (bot answers instantly)
        ▼
  ┌─────────────── WORKER (PROVISION_LOG_GROUP, concurrency 1, lock) ───────────┐
  │  PROVISIONING: createForumTopic × missing keys, persist each binding        │
  │  TESTING:      direct SYSTEM test send                                       │
  │  ACTIVE:       atomic tx — switch Settings + LogTopic together (guarded)     │
  └─────────────────────────────────────────────────────────────────────────────┘
        │ activated
        ▼
  queued log_group.connected  ──► normal delivery pipeline  ──► ✅ verified in the group
        (old group stayed active the whole time; a failure leaves it untouched)
```

### Numeric-ID troubleshooting

Each validation/setup failure maps to a concrete operator fix:

| Message / state | Fix |
| --- | --- |
| «آیدی گروه معتبر نیست…» | Re-copy the raw numeric id; it must start with `-100`. Do not paste a username, `t.me/…` link or invite link |
| «گروه پیدا نشد…» (`NOT_FOUND`) | Add the bot to the group; double-check the id belongs to *this* group |
| «گروه انتخاب‌شده سوپرگروه نیست.» (`NOT_SUPERGROUP`) | Convert/rebuild as a supergroup (a basic group upgrades to a supergroup when Topics are enabled) |
| «قابلیت موضوعات گروه فعال نیست…» (`TOPICS_DISABLED`) | Group settings → enable **Topics** |
| «ربات داخل این گروه عضو نیست…» (`BOT_NOT_MEMBER`) | Add the bot to the group |
| «ربات باید در این گروه مدیر باشد.» (`BOT_NOT_ADMIN`) | Promote the bot to administrator |
| «دسترسی مدیریت موضوعات برای ربات فعال نیست.» (`MISSING_TOPIC_PERMISSION`) | In the bot's admin rights, enable **Manage Topics** |
| «ربات اجازه ارسال پیام در این گروه را ندارد.» (`SEND_UNAVAILABLE`) | Remove the send restriction on the bot |
| «مدیر اصلی ربات باید عضو گروه انتخاب‌شده باشد.» (`OWNER_NOT_MEMBER`) | Join the group with the main OWNER account |
| «یک عملیات راه‌اندازی گروه لاگ در حال انجام است…» | Another setup already holds the single active slot — wait for it (or cancel it) before confirming a new one |
| «صف راه‌اندازی در دسترس نیست…» | Redis/worker is down — the `QUEUED` claim is rolled back; start `worker` + Redis, then retry |
| «گروه متصل شد، اما ارسال آزمایشی از صف هنوز تایید نشده است ⚠️» | The atomic switch succeeded but the queued verification test has not been confirmed sent — check the worker is running (`zedbot logs worker`) |
| «راه‌اندازی گروه لاگ کامل نشد ❌\n\nاتصال قبلی تغییری نکرده است.» | Setup failed before activation; fix the reported cause (`safeErrorCode`) and press retry — the previous group is still active |

## Operator setup flow (connection wizard — fallback)

These two group-side entry points **remain fully supported** as fallbacks
to the recommended numeric-ID flow above; all three converge on the same
validation policy and the same atomic activation. Here the binding starts
from the admin page and **completes inside the candidate group** with an
explicit confirmation — nothing binds instantly. Two equivalent group-side
entry points exist:

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
