# Background Jobs & Async Workflow Audit

Full production audit of every background job, scheduled task, retry
mechanism, timeout, queue and long-running operation in the project, with
targeted fixes for the real defects found. No business logic, Persian text
or UI flow was changed.

## Inventory

Every async/background workflow in the codebase (verified by sweeping all
`setInterval`/`setTimeout`/timer usage, queue/worker libraries, spawned
processes, event emitters, retry loops and cron references):

| # | Workflow | Where | Nature |
|---|----------|-------|--------|
| 1 | Telegram long polling | `apps/bot/src/index.ts` (`bot.start`) | grammY built-in; updates processed sequentially |
| 2 | BullMQ worker + queue | `apps/worker/src/index.ts` | placeholder jobs only; no business logic queued yet |
| 3 | Post-payment provisioning pipeline | `provisioning.service.ts` | in-request; CAS `PAID->PROVISIONING`, refund on failure |
| 4 | Renewal pipeline | `service-renewal.service.ts` | in-request; CAS claim + event-log idempotency anchor |
| 5 | Extra-volume / extra-time pipelines | `extra-volume.service.ts`, `extra-time.service.ts` | same pattern as renewal |
| 6 | Stock auto-delivery + claim retry loop | `other-product-stock.service.ts` | CAS item claim, bounded 3 attempts, resume of own RESERVED item |
| 7 | Manual delivery init | `other-product-delivery.service.ts` | unique `orderId` + P2002 fallback |
| 8 | Broadcast send loop | `broadcast.service.ts` | in-request batched sends; CAS start guard; per-recipient rows |
| 9 | Database backup (`pg_dump \| gzip`) | `backup-health.service.ts` | admin-triggered child process |
| 10 | Backup retention cleanup | `cleanupOldBackups` | admin-triggered file sweep |
| 11 | System health check | `getSystemHealth` (bot), `/health` (api, 3s `withTimeout`) | read-only probes |
| 12 | Admin receipt notification fan-out | `admin-receipt-notification.service.ts` | per-admin try/catch sends |
| 13 | Stock alert fan-out | `other-product-stock.service.ts` | per-admin try/catch sends |
| 14 | Referral apply on /start | `referral.service.ts` | guarded upsert, no funds |
| 15 | Service sync/toggle panel calls | `service-sync.service.ts`, `service-toggle.service.ts` | on-demand, 10s HTTP timeout |
| 16 | Panel adapter HTTP | `packages/panel-adapters` | every call `AbortSignal.timeout(10s)`; no token cache |
| 17 | Rate limiter window map | `rate-limit.middleware.ts` | in-memory, capped at 10k entries (clear-on-cap) |
| 18 | Session store | `app.ts` (`session()`) | grammY in-memory storage |
| 19 | Text/button template cache | `text.service.ts` | 30s lazy TTL, no timers |
| 20 | Startup delayed exits | bot/worker `index.ts` | `setTimeout(process.exit)` restart-loop damping |
| 21 | `provisionNextPaidOrders` batch | `provisioning.service.ts` | exported, deliberately unscheduled (future worker) |
| 22 | Startup crash recovery (NEW) | `startup-recovery.service.ts` | see fixes below |

There is no cron anywhere (in-process or in `scripts/`); backups are
manual admin actions. Docker services run with `restart: unless-stopped`
and healthchecks.

## Verification results (per checklist)

- **Idempotency / duplicate execution**: every money- or state-moving flow
  is anchored - wallet payments by unique `Payment.idempotencyKey`,
  approvals/refunds/broadcast-start/provisioning claims by compare-and-set
  status flips, renewal/extras by event-log rows committed with the
  mutation, stock items by per-item CAS, manual delivery by unique
  `orderId`, discount usage by per-checkout rows under a row lock.
  Verified by the integration suites (`wallet-ledger`, `discount-atomic`,
  `wallet-payment.race`, `other-product-stock`, `startup-recovery`).
- **Retry correctness**: all retry loops are bounded (stock claim: 3
  attempts; provisioning/renewal/extras persistence: exactly one retry;
  push in scripts: 4 with backoff). No infinite retry exists. grammY
  retries transport errors internally with its own backoff.
- **Timeouts**: every panel HTTP call aborts at 10s; the API health probes
  at 3s; `pg_dump` now killed by a watchdog (fix 3). grammY API calls use
  the library's default long timeout - acceptable because callers treat
  failures as non-fatal sends.
- **Deadlocks**: DB lock ordering is consistent (payment/user row ->
  discount row; single-row CAS elsewhere); the discount claim uses
  `FOR NO KEY UPDATE` specifically to avoid FK-lock deadlocks (see
  `docs/atomic-discount-consumption.md`).
- **Memory**: rate-limit map capped; template cache is two entries;
  adapters are built per call. The grammY session store is in-memory and
  unbounded per chat (see limitations).
- **Redis locks**: none exist - the worker holds no locks; BullMQ manages
  its own connection state. Nothing to leak.
- **Duplicate Telegram messages / provisioning / refunds / wallet ops
  after restart**: no job re-executes after restart because no job state
  lives in memory - all claims are DB statuses. The crash windows that
  remained are exactly the two fixed below (stuck states, not duplicates)
  plus the documented one-message resume window in stock delivery.

## Real defects found and fixed

### 1. Orders stuck in PROVISIONING forever after a crash (all four service pipelines)

**Root cause.** Each pipeline claims its order with CAS
`PAID -> PROVISIONING`, then talks to the panel and finishes COMPLETED or
FAILED+refund. The claim exists precisely so nothing else can enter - so
when the process dies between claim and finish (deploy restart, OOM,
crash), the order is stuck: every entry point (including the pipelines
themselves and `provisionNextPaidOrders`) refuses PROVISIONING orders, and
no sweeper existed. The user stayed charged with no service and no refund,
recoverable only by manual SQL.

**Why it happens.** The in-process failure handling is complete, but
crash-recovery was never implemented - the "the user is never left charged
without a service or a refund" guarantee silently assumed the process
survives the pipeline.

**Fix.** `apps/bot/src/services/startup-recovery.service.ts`, wired into
bot startup (`index.ts`): once at boot and once more after 15 minutes
(unref'd one-shot timer), resolve every service-pipeline order that has
been PROVISIONING for longer than `STALE_PIPELINE_MINUTES` (10) by the
pipeline's own documented semantics:

- completion anchor exists -> finish `COMPLETED` via CAS. For purchases
  the anchor is the order's Service row - or an unlinked Service under the
  order's deterministic panel username (same rules as the existing
  in-process recovery ladder; never another user's row). For
  renewal/extras it is the pipeline's ServiceEventLog row, which commits
  in the same transaction as the service update.
- no anchor -> the existing `failOrderWithRefund` (order `FAILED` +
  idempotent wallet refund), exactly what an in-process failure does.

**Why the fix is correct.** It introduces no new outcome - both branches
are the pipelines' own end states, decided by the same anchors the
pipelines write. Every transition is CAS-guarded and the refund path is
the already-hardened idempotent one, so repeated or concurrent sweeps
settle an order exactly once. The 10-minute staleness bound means the
sweep can never touch a live pipeline (a pipeline holds an order for
seconds: one 10s-bounded panel call plus one retried transaction).

**Why it cannot regress.** `startup-recovery.test.ts` locks the behavior:
anchored orders complete without refund (including the unlinked-service
repair), unanchored orders refund exactly once even when two sweeps race,
fresh PROVISIONING orders are never touched, and `runStartupRecovery`
never throws.

### 2. Broadcasts stuck in RUNNING forever after a crash

**Root cause.** The broadcast send loop runs inside the admin's request.
The start guard (CAS `DRAFT/CONFIRMING -> RUNNING`) correctly refuses
re-entry - which also means a crash mid-loop leaves the broadcast RUNNING
with no path forward or out.

**Fix.** The same startup sweep marks RUNNING broadcasts stale for longer
than the threshold as FAILED. `Broadcast.updatedAt` is bumped on every
batch, so a genuinely live broadcast (even a very long one) is never
touched. Recipient rows keep the exact partial sent/failed counts and no
message is ever re-sent (a new broadcast is a new recipient snapshot;
resuming the dead one is deliberately not implemented - see limitations).

**Why it cannot regress.** Test: a stale RUNNING broadcast flips to
FAILED while a fresh RUNNING one is untouched.

### 3. Backup: hung `pg_dump` was never killed

**Root cause.** `createDatabaseBackup` awaited the child process with no
timeout. libpq's default connect timeout is infinite, so an unreachable or
stalled database meant the admin action hung forever and the `pg_dump`
child was orphaned.

**Fix.** A kill watchdog (`BACKUP_TIMEOUT_MS`, default 10 minutes,
env-overridable) SIGKILLs the child; the failure is reported with the
usual scrubbed error and the partial file is removed.

**Why it cannot regress.** Test: a silent TCP listener (accepts, never
responds - the exact hang) with a 1.5s watchdog; the backup returns a safe
failure quickly and leaves no partial file.

### 4. Backup: same-second filename race corrupted output

**Root cause.** The output name was chosen by a stat-probe loop
(check-then-act). Two concurrent backups in the same second could both see
the same stamp as free, write interleaved gzip streams into ONE file, and
the loser's failure-cleanup `unlink` could then delete the winner's good
file.

**Fix.** The filename is now claimed atomically with an exclusive create
(`open(path, "wx")`) before `pg_dump` starts; the write stream uses that
handle, and failure cleanup only ever unlinks a file this call itself
created.

**Why it cannot regress.** Test: two concurrent `createDatabaseBackup`
calls must both succeed with distinct names and non-empty files.

## Remaining limitations (reviewed, deliberately not "fixed")

- **PAID orders with no pipeline run** (crash after payment commit,
  before the pipeline claim): visible in admin/user order lists, safe
  (money moved, order PAID), and `provisionNextPaidOrders` exists for a
  future worker - scheduling it is a deferred product decision, not a
  correctness fix. The startup sweep intentionally does not auto-run
  payment pipelines.
- **Recovery refunds are silent**: the sweep has no Telegram context by
  design; refunded users see the credit in their wallet history. Sending
  messages from recovery would be new user-facing behavior.
- **Stock delivery duplicate-send window** (documented in the service): a
  crash between send and finalize can re-send the SAME item once on
  resume - never two items, never another user's item.
- **Broadcast resume is not implemented**: a crashed broadcast is marked
  FAILED with accurate partial counters; the send-loop crash window means
  at most one recipient could have received the message without being
  counted SENT. Resuming would risk that duplicate; the admin decides.
- **grammY session store is in-memory**: drafts are lost on restart
  (harmless - flows re-prompt) and memory grows with active chats. A
  Redis-backed store is the project's own documented later phase.
- **grammY API calls use the library default timeout** (long but finite);
  all send failures are already treated as non-fatal.
- **Single-instance assumption**: long polling forbids two bot processes
  anyway (Telegram getUpdates conflict); all DB guards nevertheless hold
  under multi-process execution, as the race tests prove.
