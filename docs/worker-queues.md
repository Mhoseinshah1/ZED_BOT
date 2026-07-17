# Worker queues and Redis contract

The worker service (`apps/worker`) consumes two BullMQ queues and publishes
liveness/capability keys. Every name lives in **one place**:
`packages/shared/src/ops.ts` (dependency-free, imported by bot, worker and
API). The bot is only ever a **producer** and a read-only key consumer —
pg_dump, verification, cleanup and Telegram log sends all run in the
worker, never in the bot process.

## The two queues

| | `database-backup` | `telegram-operational-logs` |
| --- | --- | --- |
| Consumer | worker, **concurrency 1** | worker, **concurrency 1**, limiter **15 jobs / 60 s** |
| Producers | bot (manual/verify/cleanup), worker scheduler, worker (notify), CLI | bot (`writeSystemLog`), worker (`writeOpsLog`) |
| Worker default job options | attempts 3, exponential backoff from 10 s | attempts 5, exponential backoff from 30 s |
| Job retention | `removeOnComplete { age: 7 d, count: 100 }`, `removeOnFail { age: 30 d }` | same |

Connections use `maxRetriesPerRequest: null` (BullMQ requirement so
blocking commands survive reconnects). The bot wraps every producer
command in a **local 5 s timeout** with a 2 s connect timeout — with Redis
down an admin tap or a log write fails soft (safe Persian error, `false`
return) instead of hanging the bot.

## Backup-queue jobs

| Job name | Data | jobId | Notes |
| --- | --- | --- | --- |
| `CREATE_DATABASE_BACKUP` | `{ operationId }` | `operationId` | Bot/manual path; repeated taps can never duplicate work (BullMQ dedupes on job id). Scheduler emits the same job name with `{ scheduled: true, trigger: SCHEDULED }` and **no** operationId — the worker preflights and creates the row itself |
| `VERIFY_DATABASE_BACKUP` | `{ operationId }` | `<operationId>:verify`, `removeOnComplete/Fail: true` | Standalone re-verify; job removal keeps later re-verification possible |
| `CLEANUP_DATABASE_BACKUPS` | `{}` | `manual-cleanup`, `removeOnComplete/Fail: true` | Retention pass |
| `SEND_BACKUP_NOTIFICATION` | `{ operationId }` | `notify-<operationId>` | Owner notification; retryable Telegram failures rethrow for backoff, permanent ones give up quietly |

Failure policy: `CREATE` attempts that fail mid-chain return the operation
to `QUEUED` (intermediate) or close it `FAILED` (final attempt), then
rethrow so BullMQ records the failure — see
[backup-architecture.md](backup-architecture.md) for the full state
machine.

## Log-delivery jobs

One job name: `DELIVER_SYSTEM_LOG`, data `{ deliveryId }`, jobId =
`deliveryId` (bot) / `logdel-<deliveryId>` (worker enqueuer) — idempotent
either way because the **`SystemLogDelivery` row is the durable state**,
guarded by a status CAS. Full delivery semantics (statuses, 429 pause,
DLQ, aggregation): [operational-logging.md](operational-logging.md).

## Unknown-job policy

Both processors **throw** on any unrecognized job name
(`throw new Error("unknown job: <name>")`) so it lands in BullMQ's failed
set and surfaces in the health page's failed count — never silently
ignored. This is a deliberate reversal of the original placeholder worker,
which consumed everything and returned `{ok:false}`.

## Redis keys

| Key | Writer | Content / semantics | TTL |
| --- | --- | --- | --- |
| `zedbot:worker:heartbeat` | worker, every **15 s** | ISO timestamp of the last tick; key presence = "worker alive recently" | **45 s** |
| `zedbot:worker:capabilities` | worker, same cadence | JSON `{ pgDumpVersion, backupDirWritable, backupDir, checkedAt }` — the facts only the worker container can know (its mount is rw; the bot's is ro) | 45 s |
| `zedbot:backup:database` | worker / create-backup CLI | Global single-backup lock: `SET NX PX`, random token, compare-and-delete Lua release (never releases a lock a later run re-acquired) | 30 min (crash safety; a live run always finishes or is SIGKILLed well before) |
| `zedbot:logagg:<topicKey>:<hash>` | log-delivery consumer | 5-minute aggregation counter per identical log line (INCR; count 1 = send, >1 = skip as `aggregated`) | 300 s |

The worker deliberately holds **no direct ioredis dependency** — it reuses
the connection BullMQ already owns (`queue.client`) through a small typed
`RawRedis` interface, avoiding a second connection and pnpm resolution
issues. The bot, by contrast, keeps a separate fail-fast ioredis reader
(`maxRetriesPerRequest: 1`) for heartbeat/capability reads so a health
page can never block.

Writability is probed with a **write+unlink** test file
(`.zedbot-write-test-<pid>`) — the only reliable check on bind mounts
(`access(W_OK)` lies there).

## Scheduler reconcile

`startScheduleReconciler` runs immediately and then every **5 minutes**:
it reads the `backup_schedule_*` Settings and makes the queue's job
schedulers match — `upsertJobScheduler("scheduled-database-backup",
{ pattern }, { name: CREATE, data })` when enabled (upsert replaces a
stale pattern under the same id, so this is idempotent), or
`removeJobScheduler` when disabled. Bot-side settings changes therefore
apply without a worker restart, with at most 5 minutes of lag. Cron
patterns and the preflight are documented in
[backup-architecture.md](backup-architecture.md).

## Bootstrap and shutdown

Bootstrap (`apps/worker/src/index.ts`): connect Prisma → build both queues
→ wire the ops-log enqueuer → heartbeat loop → schedule reconciler → both
workers. Missing Redis configuration logs an error and delays the restart
loop (60 s) instead of crash-looping.

Shutdown (SIGTERM/SIGINT): stop heartbeat + reconciler → close **workers**
(in-flight jobs finish) → close **queues** → disconnect Prisma → exit 0.
