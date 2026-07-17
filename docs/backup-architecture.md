# Production backup architecture

The production-backup rework replaces the Phase 35 in-bot `pg_dump` with a
queue-driven pipeline: the **bot only requests** backups (one
`BackupOperation` row + one BullMQ job), the **worker service executes**
them (dump, verify, cleanup, notify) against a shared host directory, and a
**shell CLI path** (`zedbot backup` / `scripts/backup-db.sh`) produces the
exact same artifacts for deploys and the pre-update gate. The single source
of truth for names and conventions is `packages/shared/src/ops.ts`.

Related: [backup-encryption.md](backup-encryption.md),
[backup-restore-runbook.md](backup-restore-runbook.md),
[backup-disaster-recovery.md](backup-disaster-recovery.md),
[worker-queues.md](worker-queues.md), [system-health.md](system-health.md).

## Original defects → fixes

| # | Defect (pre-rework) | Consequence | Fix |
| --- | --- | --- | --- |
| 1 | `docker-compose.yml` mounted **no backup volume** on the bot or worker | Backups written inside the container filesystem — silently lost on every image rebuild; the CLI and the bot saw different directories | Shared bind mount: host `ZEDBOT_BACKUP_DIR` → container `/var/lib/zedbot/backups` on **bot (`:ro`)** and **worker (`:rw`)** |
| 2 | The installer created the backup directory **root-owned with mode 700 and no chown** | The containers run as UID 1000 (`node`) — the worker could not write and the bot could not read the directory at all | `install.sh`, `ensure_backup_dir_permissions` (lib/common.sh), `zedbot repair backups` and `zedbot doctor --fix` all converge on `chown ${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}` + `chmod 750` |
| 3 | The app image shipped **no PostgreSQL client** | `pg_dump`/`pg_restore` did not exist in any container; container-side backups were impossible | `Dockerfile` installs `postgresql16-client` (major pinned to the `postgres:16-alpine` server); the CI `docker-backup-smoke` job asserts `pg_dump --version` reports 16.x |
| 4 | The worker was a **placeholder that returned `{ok:false}`** for every job | Enqueued backups "completed" without producing anything; no verification, cleanup or notification existed | Real processors for the `database-backup` and `telegram-operational-logs` queues; unknown job names **throw** so they land in the failed set instead of being silently swallowed |
| 5 | The `LogTopic` table existed but was **unused scaffolding** | No operational event ever reached Telegram; the table had no writers or readers | Full delivery pipeline: `SystemLog` → `SystemLogDelivery` → queue → worker → forum topic (see [operational-logging.md](operational-logging.md)) |

## Host vs container paths

Two deliberately separate variables:

| Variable | Meaning | Default | Who reads it |
| --- | --- | --- | --- |
| `ZEDBOT_BACKUP_DIR` | **Host** directory holding all backups | `/opt/zedbot/backups` | installer, `zedbot` CLI, shell scripts, the compose bind mounts |
| `BACKUP_DIR` | **In-container** path of that same directory | `/var/lib/zedbot/backups` (`DEFAULT_CONTAINER_BACKUP_DIR` in `packages/shared/src/ops.ts`) | bot and worker processes |

`docker-compose.yml` pins `BACKUP_DIR=/var/lib/zedbot/backups` via the
`environment:` block on the bot and worker services (compose `environment`
overrides `env_file`), so `.env` normally leaves `BACKUP_DIR` empty. Setting
`BACKUP_DIR` to a host path does **not** relocate host backups — relocation
is `ZEDBOT_BACKUP_DIR`'s job.

## Ownership, permissions and mounts

- The app containers run as the image's unprivileged `node` user —
  **UID/GID 1000** (overridable via `ZEDBOT_RUNTIME_UID` /
  `ZEDBOT_RUNTIME_GID` in `.env`).
- The host backup directory is owned `1000:1000` with mode **750** (owner +
  group only, never world-accessible). Repair paths: `zedbot repair
  backups`, `zedbot doctor --fix`, the installer, and `update.sh` before the
  pre-update gate — all idempotent, none ever deletes anything or widens
  beyond 750.
- Backup files (`zedbot-db-*`) are normalized to `1000:1000` mode 640 by the
  repair helper; the worker itself creates files with mode 600 (exclusive
  `wx` create). The update safety archives (`zedbot_backup_*.tar.gz`, which
  contain `.env`) stay root-owned 600 and are never touched.
- Mounts: **bot `:ro`** (it lists, serves and deletes files through Telegram
  but must never be able to create them — CI asserts a bot-side write
  fails), **worker `:rw`** (only the worker creates, verifies and prunes).
  Because the bot cannot probe writability itself, "worker can write" and
  "pg_dump present" are published by the worker as a Redis capability
  snapshot and merely *read* by the bot (see
  [system-health.md](system-health.md)).

## The `database-backup` queue

Queue name: `database-backup` (`BACKUP_QUEUE_NAME`). Worker consumes with
**concurrency 1**. Job names (`BACKUP_JOB_NAMES`):

| Job | Payload | jobId (idempotency) | Behavior |
| --- | --- | --- | --- |
| `CREATE_DATABASE_BACKUP` | `{ operationId }` (bot/manual) or `{ scheduled: true, trigger }` (scheduler, **no** operationId) | `operationId` for bot-enqueued jobs; scheduler jobs come from the job scheduler | Runs one create+verify attempt under the global Redis lock; scheduled variant runs the preflight and creates its own row first |
| `VERIFY_DATABASE_BACKUP` | `{ operationId }` | `<operationId>:verify` (removed on completion so re-verification stays possible) | Standalone re-verification of an existing file → `VERIFIED`/`CORRUPT` + manifest update |
| `CLEANUP_DATABASE_BACKUPS` | `{}` | `manual-cleanup` | One retention pass (rules below) |
| `SEND_BACKUP_NOTIFICATION` | `{ operationId }` | `notify-<operationId>` | Persian summary to the requesting OWNER's private chat; skips silently for scheduled runs / missing token |

Retry/backoff/retention options:

- Worker-side queue defaults (`apps/worker/src/queues.ts`): **attempts 3,
  exponential backoff from 10 s**, `removeOnComplete: { age: 7 d, count:
  100 }`, `removeOnFail: { age: 30 d }`.
- Bot-side enqueue (`apps/bot/src/services/ops-queue.service.ts`) sets the
  same attempts/backoff explicitly on CREATE; VERIFY and CLEANUP jobs use
  `removeOnComplete/removeOnFail: true`.
- Only one backup can run at a time: the worker takes the Redis lock
  `zedbot:backup:database` (`SET NX PX`, TTL 30 min, compare-and-delete
  release). Lock contention **throws** so BullMQ retries the job through
  its backoff instead of skipping it.
- On an intermediate failed attempt the operation goes back to `QUEUED`
  (recording a `safeErrorCode`); on the **final** attempt it is closed as
  `FAILED` and the owner notification is enqueued — an operation can never
  rot in `QUEUED` after its job gave up.

## BackupOperation state machine

`BackupOperation` (Prisma) is the durable record; one row per attempt
chain, the row id doubles as the BullMQ job id.

```
                     (bot tap / scheduler / CLI)
                                │
                             QUEUED ──(queue unavailable at request time)──► FAILED "queue-unavailable"
                                │  CAS updateMany: QUEUED|RUNNING → RUNNING
                                ▼
                             RUNNING ──(attempt fails, retries left)──► QUEUED (+safeErrorCode)
                                │      └─(attempt fails, attempts exhausted)──► FAILED (+safeErrorCode)
                                ▼
                            COMPLETED   (file renamed, manifest written, row updated)
                                │
                             VERIFYING  (inline, same job — or a standalone VERIFY job later)
                              ┌─┴─┐
                              ▼   ▼
                         VERIFIED  CORRUPT (+safeErrorCode = verify reason)
```

`CANCELLED` exists in the enum and is treated as a failure by the
notification composer; no current code path sets it. The idempotency CAS
(`updateMany` over `QUEUED|RUNNING`) makes re-delivered/duplicated jobs
no-ops: a row already in a terminal state is reported as `alreadyDone`.
Errors are persisted **only** as short scrubbed codes (`pg-dump-exit-1`,
`disk-full`, `backup-dir-unwritable`, `pg-dump-timeout`,
`pg-dump-spawn-failed`, `encryption-failed`, `empty-output`,
`filename-collision`, `db-url-missing`, `backup-already-running`,
`queue-unavailable`, `unexpected-error`) — never raw stderr or URLs.

## Atomic file flow (`.partial` → rename)

One attempt (`apps/worker/src/backup/create.ts`):

1. Pick a collision-free name `zedbot-db-<YYYYMMDD-HHMMSS>.dump[.enc]`
   (UTC stamp; same-second collisions walk forward one second, bounded).
2. `pg_dump --format=custom --dbname <url>` — URL passed **as argv, no
   shell**; Prisma-only query params (`schema`, `connection_limit`, …) are
   stripped first so libpq accepts the URL. A watchdog SIGKILLs a hung dump
   after `BACKUP_TIMEOUT_MS` (default 10 min).
3. Output streams (optionally through the ZBK1 encryption envelope) into
   `<final>.partial`, created exclusively (`wx`, mode 600). A failed attempt
   removes **only its own** `.partial` file.
4. Empty-output guard (encrypted minimum = 33-byte header + 16-byte tag +
   1), then sha256 of the final bytes.
5. `fsync(file)` → atomic `rename(.partial → final)` → `fsync(directory)`.
   A half-written file can therefore never carry a final backup name.
6. Sidecar manifest `<final>.manifest.json` (best effort — never fails the
   operation), row updated to `COMPLETED`.
7. Inline verification: `pg_restore --list` must exit 0 with a non-empty
   table of contents (encrypted files are stream-decrypted to a temp file
   under `os.tmpdir()` first, unconditionally unlinked) → `VERIFIED` or
   `CORRUPT`.

**Why custom format:** `--format=custom` is compressed, verifiable without
a live database (`pg_restore --list`), and restorable selectively with
`--clean --if-exists` — the legacy plain `.sql.gz` offered none of that.

## Manifest fields

Worker manifest (`apps/worker/src/backup/files.ts`, camelCase):

| Field | Content |
| --- | --- |
| `operationId` | owning `BackupOperation` id |
| `filename` | final file name |
| `createdAt` | ISO timestamp |
| `appVersion` | `APP_VERSION` else `GIT_SHA` else null |
| `pgClientVersion` | `pg_dump --version` (e.g. `16.4`) |
| `dumpFormat` | always `"custom"` |
| `formatVersion` | `1` |
| `sizeBytes` / `sha256` | size and checksum of the final file |
| `encrypted` | ZBK1 envelope or plain |
| `verification` | `PENDING` → `VERIFIED` / `CORRUPT` (rewritten after verify) |

The shell path (`scripts/backup-db.sh`) writes an equivalent snake_case
manifest (`format: "v1"`, `operation_id: "cli-<stamp>"`, `git_sha`,
`pg_dump_version`, `verified: true|false`). Known cosmetic limitation:
`zedbot backup list`'s VERIFIED column greps for the shell key
`"verified": true`, so worker-created backups display `no` there even when
verified — the authoritative verification state is the `BackupOperation`
row (bot backup list) or `zedbot backup verify <file>`.

Manifests contain **no secrets**: names, sizes, hashes, versions only.

## Retention rules

Worker cleanup (`CLEANUP_DATABASE_BACKUPS`, `apps/worker/src/backup/cleanup.ts`),
covering **both** new `.dump[.enc]` and legacy `.sql.gz` files:

- Candidates: only names `classifyBackupFileName` recognizes older than
  `BACKUP_RETENTION_DAYS` (default 14, by mtime).
- **Never-delete list:** the newest backup file (unconditionally); the file
  of the newest `VERIFIED` operation; the `BACKUP_MIN_RETAINED` newest files
  (default 3) regardless of age; anything younger than the cutoff; and
  everything that does not classify — `.partial` files, `.manifest.json`
  sidecars and foreign files are structurally untouchable.
- A deleted backup takes its sidecar manifest with it. The pass writes a
  `backup_cleanup` ops log and a SYSTEM `AuditLog` row.

The shell retention in `backup-db.sh` prunes **new-format files only**
(floor of at least 1 kept even when `BACKUP_MIN_RETAINED=0`); legacy
`.sql.gz` files are counted and reported but never touched by the shell.

## Scheduled backups

Operator-editable Settings (written by the bot page «تنظیمات بکاپ خودکار
⏰», consumed by the worker):

| Setting key | Values |
| --- | --- |
| `backup_schedule_enabled` | `true`/`false` |
| `backup_schedule_interval` | `6h` → `0 */6 * * *` · `12h` → `0 */12 * * *` · `daily` → `0 <hour> * * *` · `weekly` → `0 <hour> * * 5` (Friday — the Iranian weekend) |
| `backup_schedule_hour` | 0–23, container-local timezone (UTC in the shipped compose file) |
| `backup_schedule_notify` | stored and toggled by the bot UI; **not yet consumed by the worker** — scheduled results reach the log group via the BACKUP topic regardless (disable that topic to silence them) |

The worker reconciles **one** BullMQ job scheduler
(`scheduled-database-backup`) against these Settings every 5 minutes
(`upsertJobScheduler` when enabled, `removeJobScheduler` when disabled), so
bot-side changes apply without a worker restart.

**Preflight** (scheduled runs only): backup dir writable (write+unlink
probe), free disk ≥ `BACKUP_MIN_FREE_DISK_MB` (default 500), no backup
already in flight (`RUNNING`/`VERIFYING` row), `pg_dump` present. A failed
preflight creates **no** operation row — it emits one WARN ops log
`scheduled_backup_missed` with the reason (`dir-unwritable`, `low-disk`,
`statfs-failed`, `backup-in-flight`, `pg-dump-missing`).

## Pre-update gate

`zedbot update` (`scripts/update.sh`) refuses to touch any code until a
fresh database backup was **created and verified**:

1. `[1/7]` safety archive (`.env` + database, `scripts/backup.sh`).
2. `[2/7]` `backup-db.sh`, then the newest backup is verified per type:
   `.dump` → `pg_restore --list` in the postgres container (file over
   stdin); `.dump.enc` → the worker's `verify-backup` CLI (full decrypt +
   list), falling back to a ZBK1 header check when the CLI is not built
   yet; `.sql.gz` → `gzip -t`. Any doubt **aborts the update** with the
   running installation untouched.
3. Only then: pull → build → restart → migrate → doctor.

CLI-only escape hatch (never the default, use at your own risk):

```bash
ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot update
```

## CLI parity

The worker package ships three Node CLIs that reuse the exact same modules
as the queue consumers (no logic duplicated in shell):

| CLI | Usage | Notes |
| --- | --- | --- |
| `apps/worker/dist/cli/create-backup.js` | `node … [--trigger MANUAL\|PRE_UPDATE]` | Creates + verifies one backup inline. Redis is **optional**: reachable → takes the global lock (and refuses to race a queue-driven backup, printing `backup-already-running`); down/absent → proceeds **without** the lock so a pre-update backup stays possible while the stack is half-down (ops logs then persist to Postgres only). Prints JSON `{ok, filename, verified}`; exit 0 only on verified success |
| `apps/worker/dist/cli/verify-backup.js` | `node … <path>` | Verifies a plain or ZBK1 file; encrypted files need `BACKUP_ENCRYPTION_PASSWORD`. JSON `{ok, encrypted, reason}` |
| `apps/worker/dist/cli/encrypt-backup.js` | `node … <input> <output>` | Wraps an existing file in the ZBK1 envelope (exclusive create, input untouched) |

Shell layer: `zedbot backup [create]` → `scripts/backup-db.sh` (pg_dump
custom format inside the postgres container, `pg_restore --list`
verification, encryption **delegated to the worker's encrypt CLI** — the
ZBK1 crypto is never reimplemented in shell, and a missing CLI downgrades
to an unencrypted backup with loud warnings), `zedbot backup list`,
`zedbot backup verify <file|timestamp>`, `zedbot repair backups`,
`zedbot doctor --fix`. `ZEDBOT_BACKUP_FORMAT=legacy` still produces the old
plain `.sql.gz` when explicitly requested.

## Known limitations (deliberate or accepted)

- **No restore from Telegram or the CLI, by design.** Restore is manual and
  server-only — see [backup-restore-runbook.md](backup-restore-runbook.md).
- Legacy `.sql.gz` backups are **unencrypted and effectively unverified**
  (`gzip -t` checks compression integrity, not SQL validity). They remain
  restorable and are cleaned up by the worker's retention pass, but new
  backups should always use the custom format.
- `backup_schedule_notify` is stored but not yet consumed by the worker
  (see the Settings table above).
- `zedbot backup list` shows `no` in the VERIFIED column for worker-created
  manifests (key-name mismatch, see "Manifest fields").
