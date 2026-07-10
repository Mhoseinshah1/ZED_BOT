# ZED_BOT backup, maintenance and health check (Phase 35)

Phase 35 replaces the «گزارشات / بکاپ» placeholder with a practical
operations page: a system health check, manual `pg_dump` database backups,
a backup list with in-Telegram download, retention cleanup and a
restore **instructions** page (restore is deliberately never executed from
Telegram). No payment/order/service/provisioning logic changed, no
financial rows mutated, no Service rows, no migration.

Source: `apps/bot/src/services/backup-health.service.ts`, UI in
`apps/bot/src/handlers/admin-reports-backup/reports-backup.handler.ts`.

## Admin path

پنل مدیریت 🛠 → «گزارشات / بکاپ» (`admin:reports_backup`, the existing
button — placeholder removed). Landing «گزارشات / بکاپ 🛡» buttons: «وضعیت
سیستم 🩺» (`admin:rb:health`), «ساخت بکاپ دیتابیس 💾» (`admin:rb:backup` →
confirm → `admin:rb:backup_yes`), «لیست بکاپ‌ها 🧾» (`admin:rb:list:<page>`),
«پاکسازی بکاپ‌های قدیمی 🧹» (`admin:rb:cleanup` → `admin:rb:cleanup_yes`),
«راهنمای Restore ♻️» (`admin:rb:restore_help`). File download:
`admin:rb:file:<shortId>` where the short id is the filename's
`YYYYMMDD-HHMMSS` timestamp (~29 bytes total). Health and restore-help are
readable by any admin; **create/download/cleanup are OWNER-only** (the
Admin model's role field; other roles get «این عملیات فقط برای ادمین OWNER
مجاز است.»).

## Health check (`getSystemHealth`)

- **DB** — one timed `SELECT 1` through Prisma: ✅ + latency ms, or ❌ with
  a short scrubbed error.
- **Redis** — shown as ➖ «بررسی نمی‌شود»: the queue client (bullmq) lives
  in `apps/worker`; the bot has no redis dependency and adding one just for
  a ping was deliberately skipped (documented spec option).
- **Backup dir** — exists + `W_OK` writability, checked without mutating.
- **Disk** — `execFile("df", ["-k", dir])`, parsed used/available/percent;
  «بررسی نشد» when unavailable.
- **Node** — version, uptime, pid, RSS/heap; **version** from
  `APP_VERSION`/`GIT_SHA` env when present.

## Backup creation (`createDatabaseBackup`)

`pg_dump <DATABASE_URL>` spawned with the URL **as an argument — no shell,
no string interpolation** — stdout piped through `zlib` gzip into
`BACKUP_DIR` (`process.env.BACKUP_DIR ?? /opt/zedbot/backups`, created on
demand). Filename: `zedbot-db-YYYYMMDD-HHMMSS.sql.gz` (UTC). Non-zero exit,
spawn failure (pg_dump missing) or an empty output file all delete the
partial file and return «ساخت بکاپ ناموفق بود…». Error logs are scrubbed:
the DATABASE_URL (and any `postgres://…` string) is replaced before
logging, and credentials never reach Telegram. The confirmation warns that
the dump may take a moment; the callback is answered before the work runs.

## List / download

`listBackups` reads only names matching
`^zedbot-db-\d{8}-\d{6}\.sql\.gz$` (anything else in the directory is
invisible), newest first, 10/page, rows `💾 20260710-183000 | 12.4 MB`.
`getBackupFile(shortId)` rebuilds the filename from the validated
timestamp id and containment-checks the resolved path against BACKUP_DIR —
path traversal is structurally impossible. Files ≤ 45 MB are sent with
`replyWithDocument`; larger ones get «حجم بکاپ برای ارسال در تلگرام زیاد
است…» plus the server path (the only filesystem path ever shown, and only
inside BACKUP_DIR). A failed Telegram upload reports the server path
instead.

## Cleanup

`cleanupOldBackups` deletes **matching backup files only** older than
`BACKUP_RETENTION_DAYS` (env, default 7) by mtime, behind a confirmation,
and reports the deleted count and freed bytes. Non-matching files and
fresh backups are never touched.

## Restore help

Instructions only — nothing is executed: fresh-backup warning, then the
manual server commands (`docker compose down`, copy the chosen file,
`gunzip -c … | docker compose exec -T postgres psql -U <POSTGRES_USER>
<POSTGRES_DB>`, `docker compose up -d`) with placeholders for the
credentials, which admins take from the server's `.env` themselves.

## Security

Admin middleware on everything; OWNER role required for the mutating
actions (documented: the granular AdminPermission system is not wired in
this phase). The DATABASE_URL is never printed, logged or sent; logs carry
name/size/short scrubbed errors only; filenames are regex-validated and
containment-checked; restore/migrations/.env editing/destructive resets are
intentionally absent.

## Testing

`apps/bot/tests/backup-health.test.ts` (uses a session temp directory via
`process.env.BACKUP_DIR` — never `/opt/zedbot/backups`): filename pattern
and short-id derivation; list ignoring junk files with newest-first order
and pagination; `getBackupFile` refusing traversal/garbage/unknown ids and
flagging too-large files (injectable max); cleanup deleting only old
matching files while keeping fresh backups and old junk; restore
instructions free of the DATABASE_URL and full of placeholders;
`formatBytes`; DB health ok with latency against the test database; and a
real end-to-end `createDatabaseBackup` (pg_dump → gzip → non-empty file
that lists) plus the safe-failure path (unreachable DATABASE_URL, partial
file removed) — both gated on pg_dump being installed.

## Intentionally NOT implemented

Scheduled/automatic backups, cloud/S3/Drive upload, restore execution or
migration running from Telegram, `.env` editing, destructive resets, redis
ping from the bot process, web panel, mini app, Phase 36+.
