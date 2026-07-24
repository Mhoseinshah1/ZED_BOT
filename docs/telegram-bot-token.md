# Telegram bot token — the one env contract

The bot **and** the worker read the Telegram bot token through a single shared
resolver, `resolveTelegramBotTokenFromEnv` in
`packages/shared/src/telegram-token.ts`. They can never disagree on which env var
wins. **No database migration; canonical installs need no `.env` change.**

## Why this exists

Historically the bot read `TELEGRAM_BOT_TOKEN` while the worker read only
`BOT_TOKEN`. Docker Compose gives the same `.env` to both, and the installer
writes only `TELEGRAM_BOT_TOKEN` — so a normal production install had a working
bot and a **tokenless worker**. Every worker Telegram path then failed:

- log-group setup → `bot-token-missing` (zero forum topics created);
- operational log delivery, automated notification delivery, backup Telegram
  notice, and Stars recovery all short-circuited.

This was a configuration defect, not a Telegram permission problem.

## Resolution precedence

`resolveTelegramBotTokenFromEnv(env)` is pure and exhaustive:

| Env state | Result | `source` |
| --- | --- | --- |
| only `TELEGRAM_BOT_TOKEN` | use it | `TELEGRAM_BOT_TOKEN` |
| only `BOT_TOKEN` | use it (legacy fallback) | `BOT_TOKEN` |
| both, **equal** | use `TELEGRAM_BOT_TOKEN` (duplicate-key warning) | `TELEGRAM_BOT_TOKEN` |
| both, **different** | fail closed (CONFLICT) | `CONFLICT` |
| neither | missing | `MISSING` |

Runtime accessors: the bot's `getBotToken()` (`apps/bot/src/config/env.ts`) and
the worker's `botToken()` (`apps/worker/src/config.ts`) both delegate to
`getTelegramBotToken()`, returning the token or `null` (MISSING **and** CONFLICT
both → `null`, so neither process ever runs on an ambiguous token).

### Security

The token value never leaves the resolver except as the string a caller
explicitly requested. Nothing logs the token, its length, a prefix/suffix, a
hash, or the raw env value, and no exception message ever contains a token.
Diagnostics expose only the **`source`** (the key name), never token bytes.

## Canonical configuration

New installations write **only** `TELEGRAM_BOT_TOKEN` (see `scripts/install.sh`
and `.env.example`). The worker consumes that value directly — after deploying
this code an existing canonical install needs no `.env` edit and no manual
`BOT_TOKEN` alias.

`BOT_TOKEN` exists solely as a legacy compatibility fallback for older installs.
The token is **never** auto-duplicated into a second key; migrating a legacy
`BOT_TOKEN`-only install to `TELEGRAM_BOT_TOKEN` is a manual, operator-run rename
(edit `.env`, `zedbot restart`) — the deploy never rewrites the secret for you.

## `zedbot env-check`

`scripts/validate-env.sh` matches the runtime resolver exactly:

- `TELEGRAM_BOT_TOKEN` only → `OK`;
- `BOT_TOKEN` only → `OK` + a legacy-name `WARN`;
- both equal → `OK` + a duplicate-key `WARN`;
- both different → `INVALID … TELEGRAM_BOT_TOKEN and BOT_TOKEN conflict` (fails);
- neither → `MISSING` (fails).

It prints key names and OK/WARN/INVALID/MISSING only — never a value. env-check
can therefore never report a valid environment when the bot and worker would
resolve different tokens.

## Worker diagnostics

The worker capability snapshot (`WorkerCapabilities`, published to Redis every
heartbeat) carries two safe fields:

- `telegramBotTokenConfigured: boolean`
- `telegramBotTokenSource: "TELEGRAM_BOT_TOKEN" | "BOT_TOKEN" | "MISSING" | "CONFLICT"`

The `source` reveals only the key name, never token data. It is surfaced in:

- `zedbot doctor` (a token-readiness row);
- the «بررسی نصب و بروزرسانی 🧪» deployment-diagnostics page (bot + worker rows);
- the admin «تنظیمات گروه لاگ 📝» status page (worker token line).

Persian states: «تنظیم است ✅» / «تنظیم نشده است ❌» / «دو متغیر توکن با هم مغایرت
دارند ❌» / «از نام قدیمی BOT_TOKEN استفاده می‌شود ⚠️».

## Log-group setup: preflight + retry

Before a `LogGroupSetupAttempt` is queued (and before a `bot-token-missing`
retry), the bot checks the worker's fresh capability snapshot
(`evaluateWorkerTelegramTokenReadiness`). If the worker reports `MISSING` or
`CONFLICT`, the attempt is refused with «توکن تلگرام در سرویس Worker تنظیم نشده
است.» / «تنظیمات توکن تلگرام Bot و Worker با هم مغایرت دارد.» — no QUEUED attempt
is created that is already known to be unable to call Telegram. When the snapshot
is unavailable (worker offline / older worker), the existing enqueue-time
Redis/worker-unavailable handling still applies, and the worker keeps its own
`bot-token-missing` terminal protection as the final authority.

Recovery: after the worker receives a correct token, a FAILED
`bot-token-missing` attempt is retried from the admin progress page via
«بررسی مجدد Worker و تلاش دوباره» — it rechecks the fresh snapshot, refuses while
the token is still missing/conflicting, and otherwise re-queues the SAME durable
attempt (persisted `topicBindings` retained, `createdTopicCount` resumes, the
worker resumes provisioning the missing topics, sends the SYSTEM direct test, and
activates atomically). No manual Redis deletion is needed.

## Error classification order

`classifyCreateForumTopicError` (`apps/worker/src/telegram.ts`) checks permission
patterns (`not enough rights`, `chat_admin_required`, `manage topics`, `need
administrator`) **before** broad forum/topic wording, so a
«not enough rights to create a forum topic» permission error maps to
`manage-topics-required`, not `topics-disabled`. The raw Telegram description is
never persisted.

## Limitations

- A legacy `BOT_TOKEN`-only install keeps working with a warning; migrating to
  the canonical name is a manual operator step (never auto-performed).
- The bot's log-group preflight can only see the worker's token state when a
  fresh capability snapshot exists; otherwise it defers to the worker's terminal
  `bot-token-missing` protection.
