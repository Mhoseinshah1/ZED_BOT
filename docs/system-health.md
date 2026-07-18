# System health page («وضعیت سیستم 🩺»)

The health snapshot behind پنل مدیریت → «گزارشات / بکاپ 🛡» → «وضعیت سیستم
🩺» (`admin:rb:health`, readable by any admin, «به‌روزرسانی 🔄» re-runs
it). Data assembly: `getSystemHealth()` in
`apps/bot/src/services/backup-health.service.ts`; rendering:
`buildHealthLines()` in
`apps/bot/src/handlers/admin-reports-backup/reports-backup.handler.ts`.

## Bot-read vs worker-write

The core design rule: the bot reports **only its own facts** directly; the
facts only the worker container can know are **written by the worker** into
Redis (capability snapshot, refreshed every 15 s with a 45 s TTL) and
merely **read** by the bot. The bot's backup mount is read-only in
production, so a bot-side writability or pg_dump probe would be wrong by
construction — its own `W_OK` is deliberately never used.

| Fact | Origin |
| --- | --- |
| DB latency, Redis ping, backup-dir *read* access, disk stats, latest-backup file, encryption presence, log-group settings/history | **bot-read** (its own process/mount/database) |
| backup-dir *write* access, pg_dump presence/version | **worker-write** (`zedbot:worker:capabilities`) |
| worker liveness, queue depth | worker-write heartbeat / BullMQ counts read by the bot |

## Every line and its data source

| Line | Data source | States / thresholds |
| --- | --- | --- |
| `نسخه در حال اجرا: <short sha>` / `نامشخص` (rendered **first** — a stale container invalidates every "healthy" line below it) | The bot process's own baked `GIT_SHA` env (Dockerfile build arg, normalized by `normalizeGitSha` — images built without it read as «نامشخص») | — |
| `نسخه در حال اجرای ربات با نسخه نصب‌شده روی سرور یکسان نیست ⚠️` | Running sha vs the `deployed_repo_sha` Setting (recorded by `zedbot update` / the installer via the worker `record-deploy` CLI). Appears **only** when BOTH shas are known and identify different commits — a shared prefix (short vs full form) counts as same, and an unknown side never warns | fix: `zedbot update` (see [legacy-upgrade.md](legacy-upgrade.md)) |
| `دیتابیس: ✅ (n ms)` / `دیتابیس: ❌ در دسترس نیست` | One timed `SELECT 1` through the bot's Prisma client | ok + latency, or ❌ |
| `Redis: ✅ (n ms)` / `Redis: ❌ در دسترس نیست` | One real `PING` on the bot's fail-fast ioredis reader (2 s connect, 5 s command timeout) | ok + latency, or ❌ |
| `Worker: ✅ فعال — آخرین پاسخ n ثانیه قبل` / `Worker: ❌ پاسخ نمی‌دهد` | Presence of `zedbot:worker:heartbeat` (TTL 45 s — presence alone already means "alive within 45 s"; the value adds the age) | alive iff the key exists |
| `صف بکاپ: در انتظار w \| فعال a \| ناموفق f` / `صف بکاپ: نامشخص` | BullMQ `getJobCounts` on the `database-backup` queue (bot producer connection) | `نامشخص` when Redis is unavailable |
| `پوشه بکاپ:` `خواندن ربات ✅/❌` | Bot's own `access(R_OK)` + `readdir` on `BACKUP_DIR` | — |
| `نوشتن Worker ✅/❌/نامشخص` | **Worker-published** `backupDirWritable` from the capability snapshot (write+unlink probe in the worker container) | `نامشخص` when no snapshot exists (worker down/stale) |
| `ابزار بکاپ: ✅ pg_dump <ver>` / `❌ نصب نیست` / `❌ نامشخص (Worker در دسترس نیست)` | **Worker-published** `pgDumpVersion` (`pg_dump --version` inside the worker container) | three-state: present / absent / unknown |
| `دیسک: کل … \| مصرف … \| آزاد … (n٪)` + optional `⚠️ فضای دیسک کم است` / `دیسک: ➖ بررسی نشد` | Bot-side `statfs(BACKUP_DIR)` — the filesystem holding the backups | **low** when free < `BACKUP_MIN_FREE_DISK_MB` (default 500 MB — the same threshold the worker's scheduled-backup preflight enforces) |
| `آخرین بکاپ:` time — size — verify state, or `— بکاپی وجود ندارد` + `⚠️ هنوز هیچ بکاپی ساخته نشده است` | Newest classified file in the backup dir (bot-read), joined with its `BackupOperation` row for the verify state (`تاییدشده ✅` / `نامعتبر ❌` / `نامشخص`) | — |
| `⚠️ آخرین بکاپ قدیمی‌تر از ۴۸ ساعت است` | file mtime vs now | stale at ≥ **48 h** (`LATEST_BACKUP_STALE_HOURS`) |
| `⚠️ هیچ بکاپ تاییدشده‌ای وجود ندارد` | the newest backup's verify state ≠ verified | — |
| `رمزنگاری بکاپ: فعال ✅ / غیرفعال ⚠️` | **Presence** of `BACKUP_ENCRYPTION_PASSWORD` in the bot's env — never the value | — |
| `گروه لاگ: متصل ✅ / خطا در دسترسی / تنظیم نشده` | Setting `log_group_chat_id` (configured?) + the newest `SystemLogDelivery` in `SENT`/`FAILED`/`DEAD_LETTER` by `updatedAt` (last outcome) | «خطا در دسترسی» when the latest terminal delivery failed |
| `زمان: <UTC timestamp>` | snapshot time | — |

## Log-group status and in-flight setup

The health page's `گروه لاگ:` line above reports the **bound** group only
(configured? + the newest terminal `SystemLogDelivery` outcome). The direct
numeric-ID setup feature adds a small status surface for an **in-flight**
or **failed** setup, read from these facts (all grounded in existing
building blocks; the exact labels/placement are finalized in the log-group
admin UI):

| Field | Data source |
| --- | --- |
| Connection status — `متصل ✅` / `تنظیم نشده` / **`در حال راه‌اندازی`** | `getLogGroupStatus().configured` (Setting `log_group_chat_id`) for the bound state; the "provisioning" label is derived from `getActiveSetupAttempt()` returning a row in `QUEUED`/`PROVISIONING`/`TESTING`. The `در حال راه‌اندازی` literal is **not yet in code** — it is the planned label for the active-attempt state |
| Ready topics (`n از 11`) | `getLogGroupStatus().enabledTopicCount` of `totalTopicCount` (= `OPS_LOG_TOPIC_KEYS.length` = 11); during a setup the active attempt's `createdTopicCount` shows how many of the 11 are staged so far |
| Worker heartbeat | Presence of `zedbot:worker:heartbeat` (TTL 45 s) — the same fact as the page's `Worker:` line; a setup only makes progress while the worker is alive |
| Setup-queue pending | `getLogGroupSetupQueueCounts()` — `waiting`/`active`/`delayed`/`failed` on the `telegram-log-group-setup` queue (bot producer connection; `null` when Redis is unavailable) |
| Last success / last error | `getLogGroupStatus().lastSuccessAt` (newest `SENT` delivery) and `lastError` (newest `FAILED`/`DEAD_LETTER` delivery: safe code + time) |
| Active-attempt progress | `getActiveSetupAttempt()` → `status`, `createdTopicCount`, `directTestOk`, `safeErrorCode` (masked chat id only, never the full id) |

A `FAILED` attempt carries a safe English `safeErrorCode` and leaves the
previously bound group untouched; a running attempt occupies the single
active-setup slot (see [database-invariants.md](database-invariants.md)).
The full lifecycle is in [operational-logging.md](operational-logging.md).

## Deployment diagnostics — «بررسی نصب و بروزرسانی 🧪»

The «گزارشات / بکاپ 🛡» landing gained a dedicated diagnostics page
(`admin:rb:deploy`, admin-readable, «بروزرسانی 🔄» re-runs it). Data
assembly: `getDeploymentDiagnostics()` in
`apps/bot/src/services/backup-health.service.ts`; rendering:
`renderDeployPage()` in the reports-backup handler. Every unknown renders
as «نامشخص» — nothing is ever guessed, and only **short** SHAs are shown.

| Row | Data source |
| --- | --- |
| `نسخه مخزن` | The `deployed_repo_sha` Setting — the repository HEAD recorded by the **last completed deploy** (`record-deploy` worker CLI, called by `update.sh`/`install.sh`) |
| `نسخه ربات` | This bot process's own baked `GIT_SHA` env |
| `نسخه Worker` | The worker image's baked `gitSha` from its published capability snapshot (`zedbot:worker:capabilities`) |
| `نسخه در حال اجرای ربات با نسخه نصب‌شده روی سرور یکسان نیست ⚠️` | Shown when **any pairwise difference** exists among the non-null shas above (same prefix-tolerant rule as the health page) |
| `Migration:` `بروزرسانی‌شده ✅` / `ناقص ❌` / `نامشخص` | The shipped migration directories (`packages/database/prisma/migrations`) compared against the applied rows in `_prisma_migrations` — an unreadable directory or table honestly reports «نامشخص» |
| `Mount بکاپ:` `ربات خواندن ✅/❌ \| Worker نوشتن ✅/❌/نامشخص` | Bot-read `access(R_OK)`+`readdir` probe; worker-write fact from the capability snapshot |
| `ابزار بکاپ:` `pg_dump آماده ✅` / `نصب نیست ❌` / `نامشخص (Worker در دسترس نیست)` | Worker-published `pgDumpVersion` |

**«اجرای تست بکاپ»** (`admin:rb:testbk` → confirm `admin:rb:testbk_yes`)
is **OWNER-only** and confirmed first («یک بکاپ واقعی و کامل از دیتابیس
ساخته و سلامت آن بررسی می‌شود.») — the "test" is a REAL verified database
backup, never a dry run. It reuses the exact manual-backup queue path
(`requestManualBackup`: one `BackupOperation` row, CREATE job with jobId =
operation id, at most one active operation), then lands on the same live
operation page the manual-backup button uses (`admin:rb:op:<sid>`
refreshes it). With the queue down it toasts the standard
queue-unavailable line back on the diagnostics page.

The server-side counterpart of this page is `zedbot deploy-status` — see
[legacy-upgrade.md](legacy-upgrade.md).

## Interpreting the common degraded states

- **Version-mismatch warning ⚠️** — a stale running container (the
  legacy-upgrade bug class): run `zedbot deploy-status` to see exactly
  what is out of line, then `zedbot update`. See
  [legacy-upgrade.md](legacy-upgrade.md).
- **Worker ❌ + everything else ✅** — worker container down or Redis
  unreachable from it: `zedbot logs worker`, `zedbot restart`. Manual
  backups will queue (or fail as `queue-unavailable`) until it returns;
  log deliveries accumulate as `PENDING`.
- **`نوشتن Worker ❌`** — the classic permissions defect: run
  `zedbot doctor --fix` or `zedbot repair backups` (chown 1000:1000, chmod
  750), then recheck.
- **`ابزار بکاپ: ❌ نصب نیست`** — the image predates the postgresql16-client
  layer: rebuild via `zedbot update`.
- **`نامشخص` on worker-sourced lines** — not an error by itself; it means
  the capability snapshot is absent/stale (worker down < heartbeat TTL
  ago), so the bot honestly reports "unknown" instead of guessing.
- **Stale-backup warning with the schedule enabled** — check the BACKUP
  log topic for `scheduled_backup_missed` events; the reason code names
  the failed preflight check (low-disk, dir-unwritable, pg-dump-missing,
  backup-in-flight).

Related: `zedbot doctor` covers the host-side equivalents (directory
existence/owner/mode, containers, connectivity) — see
[production-install-phase36.md](production-install-phase36.md);
key/TTL details in [worker-queues.md](worker-queues.md).

## Notification engine status (feat/notification-retention-engine, Phase 1)

The worker publishes `zedbot:notif:worker-status` (JSON, heartbeat TTL) read by
the admin «اعلان‌ها و یادآوری‌ها 🔔» page via `readNotificationWorkerStatus()`:
`schedulerActive`, `lastServiceSyncAt`, `lastServiceScanAt`, `deliveryWaiting`,
`deliveryFailed`, `deadLetter`, `checkedAt`. A missing/stale key ⇒ the page
shows "بدون گزارش/قدیمی" and the master-enable activation gate refuses. See
[notification-operations-runbook.md](notification-operations-runbook.md).

## Checkout-payment reminder status (Phase 2)

The worker status snapshot (`zedbot:notif:worker-status`) gains
`lastCheckoutScanAt`, `abandonedCheckoutCandidates` and `paymentRetryCandidates`.
The admin «اعلان‌ها و یادآوری‌ها 🔔» page shows «آخرین بررسی سفارش‌های ناقص» /
«آخرین بررسی پرداخت‌های ناموفق» + candidate counts. Enabling either checkout rule
requires the same fresh-status activation gate as the Phase-1 rules.

## Customer win-back status (Phase 3)

The worker status snapshot gains `lastRetentionScanAt`, `winbackCandidates`,
`winbackScheduled`, `winbackExcludedUncertainService` and `retentionScanFailures`
(all optional, for rolling upgrades). The admin «بازگرداندن مشتریان غیرفعال 👋»
page shows «آخرین بررسی بازگشت مشتری» + the dry-run audience estimate (تخمینی).
Enabling the win-back rule requires the same fresh-status activation gate as the
other rules, PLUS a healthy retention scheduler and ≥1 allowed user group. A large
`winbackExcludedUncertainService` means paid-service state is stale (priority
syncs are being enqueued); win-back is never sent on a guess. All fields are
counts/timestamps only — never a user id or financial value.
