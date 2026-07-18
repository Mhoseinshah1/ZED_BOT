# Worker queues and Redis contract

The worker service (`apps/worker`) consumes three BullMQ queues and
publishes liveness/capability keys. Every name lives in **one place**:
`packages/shared/src/ops.ts` (dependency-free, imported by bot, worker and
API). The bot is only ever a **producer** and a read-only key consumer —
pg_dump, verification, cleanup, Telegram log sends and log-group topic
provisioning all run in the worker, never in the bot process.

## The three queues

| | `database-backup` | `telegram-operational-logs` | `telegram-log-group-setup` |
| --- | --- | --- | --- |
| Consumer | worker, **concurrency 1** | worker, **concurrency 1**, limiter **15 jobs / 60 s** | worker, **concurrency 1** |
| Producers | bot (manual/verify/cleanup), worker scheduler, worker (notify), CLI | bot (`writeSystemLog`), worker (`writeOpsLog`) | bot (`enqueueLogGroupSetup`, on OWNER confirm) |
| Worker default job options | attempts 3, exponential backoff from 10 s | attempts 5, exponential backoff from 30 s | attempts 3, exponential backoff from 15 s |
| Job retention | `removeOnComplete { age: 7 d, count: 100 }`, `removeOnFail { age: 30 d }` | same | same |

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

## Log-group-setup jobs

One job name: `PROVISION_LOG_GROUP`, data `{ attemptId }`, jobId =
`log-group-setup-<attemptId>` (`logGroupSetupJobId`) — so a repeated OWNER
confirmation of the **same** attempt never creates a second provisioning
job (BullMQ dedupes on the id), and the `LogGroupSetupAttempt` row is the
durable resume point.

| Job name | Data | jobId | Notes |
| --- | --- | --- | --- |
| `PROVISION_LOG_GROUP` | `{ attemptId }` | `log-group-setup-<attemptId>` | Creates the eleven default forum topics (per-topic durable bindings — resume-safe, persisted topics never re-created), sends a direct SYSTEM test, then **atomically** switches the active group (Settings + `LogTopic` together, guarded on the attempt still being non-cancelled) and emits the queued `log_group.connected` self-verification. Attempts 3, exponential backoff from 15 s |

The processor is **idempotent + resume-safe**: it CAS-claims the row
(`QUEUED`/`PROVISIONING`/`TESTING` → `PROVISIONING`), so a re-delivered or
crashed job resumes from the saved `topicBindings`; a terminal
(`ACTIVE`/`CANCELLED`) row is skipped. It holds the single Redis lock
`zedbot:log-group:setup` (`SET NX PX`, 5-minute TTL) for the duration and
releases it in `finally`; a lock miss re-throws for BullMQ back-off rather
than running a second concurrent provision. The active group is switched
**only** after all topics exist and the direct test send succeeds, so a
failed setup leaves the previous group untouched.

**Slot never leaks on failure.** The whole post-claim body is wrapped so that
on the **final** BullMQ attempt *any* terminal throw — a still-held lock from
a dead worker, a transient activation DB error, an unexpected error — runs
`failAttempt` (status → `FAILED`, `activeSlot` → `NULL`) before propagating.
Earlier attempts keep the slot held so the same durable row resumes; it is
freed only when the attempt is truly terminal. The `PROVISIONING → TESTING`
transition is a guarded `updateMany` whose zero count is a race check: a cancel
that lands in that window skips the test send instead of posting it into a group
no longer being activated. A worker that dies with its job lost is picked up by
the bot's startup **resume sweep** (`resumeStaleLogGroupSetups` in
`startup-recovery.service.ts`) — any running attempt stale past
`STALE_PIPELINE_MINUTES` is re-enqueued (idempotent jobId), so the single-setup
slot has an automatic reaper and never strands.

One bounded caveat: a crash in the narrow window between a `createForumTopic`
response and its per-topic persist can orphan **one** empty forum topic
(Telegram's Bot API exposes no list/dedupe to reconcile it). That topic is never
bound — activation consumes only persisted bindings — so it is harmless. Full
lifecycle, cancellation and the activation trust boundary:
[operational-logging.md](operational-logging.md).

Forum topics are created with the worker's own **fetch-based**
`createTelegramForumTopic` (`apps/worker/src/telegram.ts`, POST
`createForumTopic`) — the same token-scrubbing and safe-code classification
as `sendTelegramMessage`: the bot token appears only in the request URL,
never in an error, log or return value.

## Unknown-job policy

All three processors **throw** on any unrecognized job name
(`throw new Error("unknown job: <name>")`) so it lands in BullMQ's failed
set and surfaces in the health page's failed count — never silently
ignored. This is a deliberate reversal of the original placeholder worker,
which consumed everything and returned `{ok:false}`.

## Redis keys

| Key | Writer | Content / semantics | TTL |
| --- | --- | --- | --- |
| `zedbot:worker:heartbeat` | worker, every **15 s** | ISO timestamp of the last tick; key presence = "worker alive recently" | **45 s** |
| `zedbot:worker:capabilities` | worker, same cadence | JSON `{ pgDumpVersion, backupDirWritable, backupDir, gitSha, checkedAt }` — the facts only the worker container can know (its mount is rw; the bot's is ro); `gitSha` is the worker image's baked build identity (null when built without it) | 45 s |
| `zedbot:backup:database` | worker / create-backup CLI | Global single-backup lock: `SET NX PX`, random token, compare-and-delete Lua release (never releases a lock a later run re-acquired) | 30 min (crash safety; a live run always finishes or is SIGKILLed well before) |
| `zedbot:log-group:setup` | log-group-setup consumer | Global single-setup lock: only one `PROVISION_LOG_GROUP` job provisions at a time; `SET NX PX`, released in `finally`. A contended acquire re-throws for BullMQ back-off | 5 min (comfortably above provisioning 11 topics + one test send) |
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

## Deploy CLIs (record-deploy, migration-status, deploy-smoke)

Besides the backup CLIs (create/verify/encrypt — see
[backup-architecture.md](backup-architecture.md)), the worker ships three
deployment CLIs used by the shell layer. All three print **one line of
secret-free JSON** on stdout (no env values, no connection strings) and
signal success purely via the exit code.

| CLI | Usage | JSON contract | Called by |
| --- | --- | --- | --- |
| `apps/worker/dist/cli/record-deploy.js` | `node … <git-sha>` | `{ok: true, sha}` exit 0; `{ok: false, error: "invalid-sha"}` exit 1 on a bad argument | `record_deployed_sha` (lib/common.sh) at the end of `update.sh` and the migrate.sh legacy self-heal; `install.sh` keeps an inline bootstrap copy of the same call. Upserts the `deployed_repo_sha` + `deployed_repo_sha_recorded_at` Settings; the bot compares its own baked `GIT_SHA` against them to detect stale containers |
| `apps/worker/dist/cli/migration-status.js` | `node …` | `{ok: true, appliedCount, pendingCount, failedCount, upToDate, pendingNames}` exit 0 (`pendingNames` capped at 5); `{ok: false, error: "db-unreachable"\|"migrations-dir-missing"}` exit 1. A fresh database without `_prisma_migrations` reads as "nothing applied yet" | `zedbot deploy-status` (its `Migrations : pending=… upToDate=…` line). Compares the migrations **shipped in the image** against the applied `_prisma_migrations` rows |
| `apps/worker/dist/cli/deploy-smoke.js` | `node …` (budget: `ZEDBOT_SMOKE_TIMEOUT_SECONDS`, default 240) | `{ok, failureCategory, filename, operationId, steps}` — `steps` is an ordered `{name, ok, info?}` list (`redis`, `worker-heartbeat`, `backup-dir-writable`, `pg-client`, `backup-enqueue`, `backup-verified`, `backup-file`); `failureCategory` null on success. Exit 0/1 | Step 10 of `update.sh` in a one-off worker container, while the **running** worker processes the smoke's real enqueued backup (same payload/jobId/attempts contract as the bot's `enqueueBackupCreate`). Sends nothing to Telegram, deletes nothing |

Failure categories and the update script's handling of them are documented
in [legacy-upgrade.md](legacy-upgrade.md).

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

Bootstrap (`apps/worker/src/index.ts`): connect Prisma → build all three
queues → wire the ops-log enqueuer → heartbeat loop → schedule reconciler
→ all three workers (backup, log-delivery, log-group-setup). Missing Redis
configuration logs an error and delays the restart loop (60 s) instead of
crash-looping.

Shutdown (SIGTERM/SIGINT): stop heartbeat + reconciler → close **workers**
(in-flight jobs finish) → close **queues** → disconnect Prisma → exit 0.

---

## Notification / retention engine queues (Phase 1)

The worker also owns four notification queues (started by
`apps/worker/src/notifications/engine.ts`, dormant while the master switch is
off). See [notification-architecture.md](notification-architecture.md).

| Queue | Job(s) | Concurrency | Default job opts |
|-------|--------|-------------|------------------|
| `service-state-sync` | `SYNC_PANEL_SERVICES` (`{panelId?}` — one panel or all) | 1 | 2 attempts, 15 s backoff |
| `automated-notification-scan` | `SCAN_SERVICE_NOTIFICATIONS` | 1 | 1 attempt |
| `automated-notification-delivery` | `DELIVER_AUTOMATED_NOTIFICATION` (`{notificationId}`) | 1 + limiter 15/60 s | 5 attempts, 30 s backoff |
| `automated-notification-maintenance` | `RECONCILE_FAILED_NOTIFICATIONS`, `CLEANUP_NOTIFICATION_HISTORY` | 1 | 1 attempt |

Job ids are derived from the entity id (`psync-<panelId>`,
`ntfdel-<notificationId>`) so a retried/duplicated enqueue collapses onto the
same job — the DB row + its `dedupeKey` are the durable idempotency anchors.

**Scheduler** (`scheduler.ts`) reconciles the recurring jobs every 5 min from
Settings (`upsertJobScheduler`), and removes them all while the master switch is
off. **Redis keys**: `zedbot:panel-sync:<id>` (per-panel sync lock),
`zedbot:panel-breaker:<id>` (circuit-breaker counter, `INCR`+`EXPIRE 600s`),
`zedbot:notif:worker-status` (JSON status snapshot, heartbeat TTL — read by the
admin health page).

Shutdown closes the notification workers + queues alongside the existing ones.

### Checkout-payment reminders (Phase 2)

Reuses the existing `automated-notification-scan` queue — no new queue. A second
recurring scheduler `notif-sched-checkout-scan` emits `SCAN_CHECKOUT_NOTIFICATIONS`
(default every 10 min) on the scan queue, registered ONLY while at least one of
the two checkout rules is enabled (removed otherwise). The processor
(`checkout-scan.ts`) creates dedupe-guarded `AutomatedNotification` rows
(category PAYMENT) for abandoned checkouts + failed online payments and enqueues
them on the SAME delivery queue + worker. Delivery re-validates live financial
state before send (`revalidateCheckoutSource`). No new delivery/quiet-hours/
limit/retry logic. Heartbeat gains `lastCheckoutScanAt`,
`abandonedCheckoutCandidates`, `paymentRetryCandidates`.

### Customer win-back (Phase 3)

Reuses the existing `automated-notification-scan` queue — no new queue. The
reserved scheduler `notif-sched-retention-scan` emits `SCAN_RETENTION_NOTIFICATIONS`
(default every 1440 min / daily) on the scan queue, registered ONLY while
`notification_customer_winback_enabled` is on (removed otherwise). The processor
(`winback-scan.ts` → `winback-eligibility.ts`) cursor-paginates narrowed candidate
users, builds each `CustomerLifecycleSnapshot` from authoritative rows, calls the
shared resolver, and creates dedupe-guarded `CUSTOMER_WINBACK` rows (category
MARKETING) for genuine lapsed paying customers, enqueuing them on the SAME
delivery queue + worker. A stale paid-service state enqueues a **priority
`SYNC_PANEL_SERVICES`** (reusing the Phase 1 service-sync queue) and skips the
candidate — never guessing inactivity. Delivery re-validates live state
(`revalidateWinbackSource`): cancel on a new usable service / changed lapse cycle,
suppress on opt-out/snooze, defer on uncertain state. No new delivery/quiet-hours/
limit/retry logic. Heartbeat gains `lastRetentionScanAt`, `winbackCandidates`,
`winbackScheduled`, `winbackExcludedUncertainService`, `retentionScanFailures`.

## Phase 4 — attribution maintenance jobs

The analytics/attribution phase adds four job names on the **existing**
`automated-notification-maintenance` queue (no new queue). All are gated on the
analytics master switch — a disabled install runs none:

| Job | Cadence | Purpose |
|-----|---------|---------|
| `RECONCILE_NOTIFICATION_ATTRIBUTION` | on demand | one completed Order (after-commit hook, `{ orderId }`, jobId per-order) |
| `RECONCILE_NOTIFICATION_ATTRIBUTION_BATCH` | 15 min | catch-all sweep of recently-completed Orders (newest first, excludes already-attributed) |
| `RECONCILE_NOTIFICATION_ATTRIBUTION_REVERSALS` | 60 min | flip refunded Orders' attributions to REVERSED (idempotent SQL) |
| `CLEANUP_NOTIFICATION_ATTRIBUTION` | daily | prune attributions past retention (standalone deleteMany, no cascade) |

Scheduler ids: `attributionBatch` / `attributionReversals` / `attributionCleanup`.
The bot enqueues the per-order hook + a manual reconcile through
`ops-queue.service.ts` (fail-soft producer). See
[conversion-attribution.md](conversion-attribution.md).
