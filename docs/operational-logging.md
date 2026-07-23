# Operational logging (SystemLog → Telegram delivery)

Every operational event is persisted as a **`SystemLog` row first** (the
source of truth), then — when it maps to an enabled log topic — delivered
asynchronously to the Telegram log group by the worker. Writing a log can
**never** break or slow the operation that emitted it, and a broken log
group can never generate logs about itself.

Code: bot writer `apps/bot/src/services/system-log.service.ts`; worker
writer `apps/worker/src/ops-log.ts`; consumer
`apps/worker/src/log-delivery.ts`; shared sanitizer + topic keys
`packages/shared/src/ops.ts`. Group management:
[telegram-log-group.md](telegram-log-group.md).

## The writer API

Bot side — `writeSystemLog(args)`:

```ts
writeSystemLog({
  level: "INFO" | "WARN" | "ERROR",
  eventType: string,            // stable English marker, e.g. OPS_EVENTS.PAYMENT_SETTLED
  message: string,              // human line; scrubbed, max 1000 chars
  metadata?: Record<string, unknown>,   // allowlisted fields only
  topicKey?: OpsLogTopicKey,    // when set, also queued for Telegram
  userId?, adminId?, orderId?, paymentId?, serviceId?,   // soft references (plain ids, no FKs)
});
```

Worker side — `writeOpsLog({ level, topicKey, eventType, message,
metadata })`, same semantics (topicKey required there; the worker's
messages are the Persian backup-lifecycle lines).

Guarantees, both sides:

- **Never throws.** Any internal failure goes to the local stdout logger
  only.
- `SystemLog` is created first; the Telegram part is best-effort on top.
- The delivery row is created only when the topic exists and `isEnabled`
  (bot side additionally requires the log group to be configured); the
  `@@unique([systemLogId, logTopicId])` pair plus `P2002`-recovery /
  `skipDuplicates` make re-entrant calls converge on one row.
- References are soft ids so log writes never fail on FK issues.

## Event catalog

Bot events (`OPS_EVENTS`) — stable markers; behavior and queries bind to
these, never to the human messages:

| eventType | Level | Topic | Emitted when |
| --- | --- | --- | --- |
| `bot.started` / `bot.stopped` | INFO | SYSTEM | bot process lifecycle |
| `payment.settled` | INFO | PAYMENT | gateway payment settled |
| `payment.duplicate_success` | WARN | PAYMENT | duplicate provider success filed for reconciliation |
| `payment.receipt_approved` | INFO | PAYMENT | manual receipt / wallet top-up receipt approved |
| `payment.receipt_rejected` | WARN | PAYMENT | manual receipt rejected |
| `order.provision_completed` / `order.provision_failed` | INFO / ERROR | ORDER | post-payment provisioning outcome |
| `service.operation_completed` / `service.operation_failed` | INFO / ERROR | SERVICE | renewal / extra volume / extra time etc. outcome |
| `panel.connection_failed` | WARN | PANEL | panel unreachable during service sync |
| `security.admin_access_denied` | WARN | SECURITY | non-admin hit the admin area |
| `wallet.manual_adjustment` | WARN | AUDIT | admin manually changed a user wallet |
| `backup.deleted` | WARN | AUDIT | admin deleted a backup file from Telegram |
| `log_group.changed` | WARN | SECURITY | log group (re)configured or disconnected |

Worker events — backups (all topic BACKUP): `backup_started` (INFO),
`backup_completed` (INFO), `backup_verified` (INFO), `backup_corrupt`
(ERROR), `backup_failed` (ERROR), `backup_cleanup` (INFO),
`scheduled_backup_missed` (WARN). Log-group setup: `log_group.topic_created`
(INFO, topic SECURITY — one per staged forum topic) and
`log_group.connected` (INFO, topic SYSTEM — the queued self-verification
emitted after a successful atomic activation, see below).

Topics `ERROR`, `SUPPORT` and `BROADCAST` currently have **no emitters**
(reserved keys — they exist, can be toggled and test-messaged, but nothing
routes to them yet).

## Sanitization: allowlist policy + last-line scrubber

**The policy is the allowlist:** callers pass only explicitly chosen safe
fields — ids, amounts, statuses, short codes. Never payloads, URLs,
tokens, panel configs or raw error text.

The shared sanitizer (`sanitizeOpsMetadata` / `scrubSecretsFromText`) then
runs as the **last line of defense, not the policy** — at write time, and
again at render time in the worker (defense in depth):

- Key denylist: any metadata key matching
  `token|password|secret|authorization|cookie|database_url|api_key|merchant_id|subscription_*|config|credential|private_key|encrypted|…`
  is replaced with `[redacted]`.
- Value scrubbing: `postgres://…`, `redis://…`, `vless/vmess/trojan/ss://…`
  URIs, Telegram-bot-token shapes, JWTs and long hex secrets (≥ 48 chars)
  are replaced inside every string.
- Bounds so a hostile payload cannot explode the row: depth ≤ 4, arrays
  ≤ 20 items, objects ≤ 30 keys, strings ≤ 500 chars; the message itself
  is capped at 1000 chars (bot side).

The CI `docker-backup-smoke` job additionally asserts that no
`postgres://` URL or bot-token-shaped string ever appears in captured
container logs.

## Delivery model

```
writeSystemLog / writeOpsLog
  └─ SystemLog row (always)
       └─ SystemLogDelivery row (PENDING)          ── unique [systemLogId, logTopicId]
            └─ BullMQ DELIVER_SYSTEM_LOG job        ── jobId = deliveryId (bot) / logdel-<id> (worker)
                 └─ worker: resolve topic + chat → compose → sendMessage(message_thread_id = topicId)
```

Statuses (`LogDeliveryStatus`):

| Status | Meaning |
| --- | --- |
| `PENDING` | row created, send not yet attempted |
| `SENDING` | claimed by the CAS (`PENDING`/`FAILED`/`SENDING` → `SENDING`); `SENDING` is re-claimable so a crash mid-send can be retried |
| `SENT` | delivered; `telegramMessageId` + `sentAt` recorded; terminal — the SENT check plus concurrency 1 guarantee a known-successful send never repeats |
| `FAILED` | attempt failed, retryable; `attempts`, `safeErrorCode`, `nextAttemptAt` recorded |
| `DEAD_LETTER` | gave up: attempts exhausted, or a permanent Telegram rejection (`forbidden` / `chat-not-found` / `topic-missing` / `bad-request`) — dead-lettered immediately, retrying cannot help |
| `SKIPPED` | never sent on purpose: `topic-unmapped`, `topic-disabled`, `log-group-unset`, `bot-token-missing`, or `aggregated` |

The delivery **row** is the durable source of truth; jobs are disposable
(bot-enqueued jobs use `removeOnComplete/removeOnFail: true` so a stuck
delivery can always be re-enqueued under the same id).

Message format (plain text, no parse_mode — operator text must not break
entity parsing): level emoji (ℹ️/⚠️/🛑) + `#eventType` hashtag, the
message, then up to 10 metadata bullet lines (200 chars each), total
capped at 3900 chars.

## Retries, backoff, rate limit, DLQ

- **Attempts:** 5 per delivery, exponential backoff (bot-enqueued jobs
  start at 5 s; worker-enqueued jobs use the queue default of 30 s — the
  options attached at `add()` time win).
- **Throughput cap:** the log-delivery worker runs with concurrency 1 and
  a BullMQ limiter of **max 15 sends per 60 s** — safely inside
  Telegram's group limits.
- **429 handling:** on `rate-limited` the whole queue is paused for
  Telegram's `retry_after` and the job is put back **without consuming an
  attempt** (`Worker.RateLimitError`).
- **Network / 5xx:** retryable — rethrown so BullMQ applies the backoff.
- **Permanent rejections** dead-letter immediately (see table above).
- Failure bookkeeping never leaks payloads: only short safe codes
  (`rate-limited`, `forbidden`, `chat-not-found`, `topic-missing`,
  `bad-request`, `network-error`, `telegram-5xx`).

## Aggregation (flood control)

Identical lines (same `eventType` + `message`, hashed) within one topic are
aggregated over a **5-minute window** (Redis
`zedbot:logagg:<topicKey>:<hash>`, INCR + EXPIRE 300 s): the first
occurrence is delivered, repeats inside the window are marked
`SKIPPED aggregated`. **Documented simplification:** no trailing
"repeated N times" summary is flushed — the counter simply expires and the
next occurrence after the window is delivered again. If the counter bump
itself fails (Redis blip), the delivery is sent anyway (fail-open).

## Anti-recursion rule

**Nothing in the delivery path ever creates `SystemLog` rows.** Every
failure inside `log-delivery.ts`, `telegram.ts` or the writers themselves
is reported only through the local JSON logger and the
`SystemLogDelivery` row — otherwise a broken log group would generate
logs about failing to deliver logs, forever. The same rule holds for the
writers: their catch blocks log locally and never re-enter
`writeSystemLog`/`writeOpsLog`.

## Log-group setup: the persistent setup attempt

Binding the log group via a numeric chat id (and, converged onto the same
policy, `/setloggroup` + the wizard — see
[telegram-log-group.md](telegram-log-group.md)) runs as a **durable
operation**, not an inline callback: one `LogGroupSetupAttempt` row drives
one `PROVISION_LOG_GROUP` worker job. Topic creation and the test send are
the worker's job (`apps/worker/src/log-group-setup.ts`), never the bot's;
the DB row is the source of truth and the resume point.

**Lifecycle** (`LogGroupSetupStatus`):

```
VALIDATED ──confirm (CAS + activeSlot=1)──► QUEUED ──worker claim──► PROVISIONING
                                                                         │
                                              all topics staged ─────────┤
                                                                         ▼
                                                                      TESTING ──test ok──► ACTIVE
   any of VALIDATED/QUEUED/PROVISIONING/TESTING ──cancel──► CANCELLED
   provisioning / test failure (final attempt)  ──────────► FAILED
```

- `VALIDATED` — the preview: the target passed the shared policy, but
  nothing is bound and the active slot is free (several previews may
  coexist).
- `QUEUED` — the OWNER confirmed; the attempt claimed the single active
  slot (`activeSlot = 1`) and the job was enqueued.
- `PROVISIONING` — the worker CAS-claimed the row and is creating the
  eleven default forum topics.
- `TESTING` — all topics exist; the worker is sending the direct SYSTEM
  test.
- `ACTIVE` — the atomic activation committed; the group is live.
- `FAILED` — a step failed on the final attempt; a safe English
  `safeErrorCode` is recorded and the active slot is freed.
- `CANCELLED` — the OWNER cancelled before activation.

**Staged topic provisioning (per-topic durable bindings, resume-safe,
never re-create).** For each stable OPS key not already present in the
attempt's `topicBindings`, the worker calls `createForumTopic` and writes
the resulting `{ "<KEY>": <messageThreadId> }` binding (plus
`createdTopicCount`) to the row **immediately, before the next create**. A
crashed or retried job re-reads `topicBindings` and skips every key it
already holds — so a worker restart resumes mid-way and no topic is ever
created twice. `topicBindings` holds **only** stable-key → thread-id
pairs — never content, tokens or API payloads.

**Atomic activation (the trust boundary).** The currently active group is
**never overwritten until the staged group is fully provisioned *and* the
direct SYSTEM test send has succeeded.** Activation is one transaction that
switches the `log_group_chat_id` + `log_group_title` Settings **and** the
`LogTopic` rows together, guarded by a CAS on the attempt still being in a
running (`PROVISIONING`/`TESTING`) state. If a cancel or a concurrent
activation moved the row first, the guarded update matches zero rows and
the **whole transaction rolls back** — nothing is written, so a partial
switch is impossible. A setup that fails at any earlier step therefore
leaves the previously active log group working, untouched.

**Retries.** The job runs with 3 attempts, exponential backoff from 15 s.
A retryable Telegram failure (rate-limit, network, 5xx) on a non-final
attempt re-throws so BullMQ backs off and the next attempt resumes from
the saved bindings; a permanent failure, or any failure on the final
attempt, marks the attempt `FAILED` with the safe code and frees the slot.
The single Redis lock `zedbot:log-group:setup` serializes provisioning; a
lock miss is a retryable back-off, never a second concurrent run.

**Cancellation.** Cancelling a not-yet-active attempt
(VALIDATED/QUEUED/PROVISIONING/TESTING) flips it to `CANCELLED`, frees the
active slot and **preserves everything else**: the currently active group
stays bound, the attempt row is kept as audit history, and already-created
staged forum topics are **never deleted** — they remain recorded in
`topicBindings` so a later retry reuses them.

**Queued self-verification.** After activation the worker emits a normal
`log_group.connected` ops log
(«گروه لاگ با موفقیت متصل و فعال شد ✅») through `writeOpsLog` — i.e. the
**same** `SystemLog` → `SystemLogDelivery` → BullMQ `DELIVER_SYSTEM_LOG` →
`sendMessage` pipeline as every operational event. Its arrival in the
group's SYSTEM topic thus proves the whole chain — log persistence,
delivery-row creation, the delivery queue, topic routing and real Telegram
delivery — end to end, not just that the group is reachable. (The earlier
direct test send during `TESTING` bypasses the queue; this final event
does not.)

## Limitations

- **Delivery requires the worker to be running.** With the worker down,
  `SystemLog` rows and `PENDING` deliveries still persist, but nothing is
  sent (the bot's test messages still work — they are sent by the bot).
- **No PENDING re-sweep exists yet.** If the *enqueue* itself is lost
  (Redis down at write time, or the CLI running without Redis), the
  delivery row stays `PENDING` indefinitely — code comments reserve a
  "worker sweep" for this, but none is implemented. Rows delivered
  normally are unaffected.
- Aggregation loses the repeat count (see above) — the full record is
  always in `SystemLog`.
- `ERROR`/`SUPPORT`/`BROADCAST` topics have no emitters yet.

## Pricing Catalog privacy (feat/public-pricing-catalog)

Opening or navigating the public retail Pricing Catalog («تعرفه‌ها») writes **no**
`SystemLog` row per tap — there is deliberately no noisy per-view logging. The
pages never render a panel base URL, credentials, API variant, token,
subscription domain, inbound ids, config link, stock count/content, or
customer-input schema internals; all operator-controlled values are HTML-escaped
and length-bounded, and callbacks never carry a price, a full id, or free-form
text. See `docs/public-pricing-catalog.md`.
