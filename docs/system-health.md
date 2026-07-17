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

## Interpreting the common degraded states

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
