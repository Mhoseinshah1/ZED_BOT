# The support-ticket domain

Support tickets are now reachable from two places that share nothing else: the
bot receives a Telegram update, the Mini App API receives a JSON body. This
describes what they share, what they deliberately do not, and why each boundary
sits where it does.

## Why a package and not a service

`@zedbot/support-tickets` holds every rule that decides an **outcome**. Persian
strings, keyboards, HTTP status codes — anything that decides a
**presentation** — stays in the app that renders it.

The split is not stylistic. If each surface validated a subject, decided a
transition and scoped a query its own way, the two would agree on the day they
were written and drift the first time someone edited one of them. And the drift
is not symmetric: a bot bug annoys a user, while an API bug is reachable by
anyone holding a session cookie.

The package depends on `@zedbot/database` and `@zedbot/shared` and nothing else.
It cannot import grammY, Fastify, React or a keyboard — not by convention, but
because those are not dependencies of the package.

`packages/shared` was not an option: it has no dependencies at all, so nothing
that touches Prisma can live there. `@zedbot/force-join` established the shape
this follows.

## Bounds

| Bound | Value |
| --- | --- |
| Subject | 3–100 characters, after trimming |
| Message | 1–3000 characters, after trimming |

These live in `packages/support-tickets/src/contract.ts` and **only** there. The
bot re-exports them; it does not declare them.

Two tests enforce that:

- `S2-2` scans every source root and fails if any file other than the contract
  declares a bound. This binds surfaces that do not exist yet — whoever builds
  the Mini App composer has to source the numbers rather than retype them.
- `S2-5` … `S2-8` run the same boundary values through both real entry points
  against a real database, because identical constants are not the same as
  identical behaviour. Measuring before trimming rather than after, `>` rather
  than `>=`, or storing an untrimmed value while validating a trimmed one all
  keep the numbers equal and still make one surface accept what the other
  refuses.

## Public identifiers

A ticket's primary key is a UUID. It is internal: it appears in operator logs,
in admin screens and in support transcripts, so once it is in a URL or a
screenshot it correlates those contexts for anyone who sees both.

What a user sees — in the bot and in the browser — is the first 8 hex characters
(`ticketShortId`). One value, one format, one place that decides it.

Hex is case-insensitive, so `AB12CD34` and `ab12cd34` name the same row.
`canonicalPublicId` is the single normalizer, and **both** the lookup and the
idempotency fingerprint use its output, never the raw transport value. That was
a real defect: a fingerprint built from the raw string made a retry that changed
case look like a different mutation, so a client that upper-cased the id was
told its own retry conflicted.

**A database UUID is never accepted from a browser.**

## Resolution

Ownership is enforced **in the query**, not checked after the read:

```ts
where: { id: { startsWith: canonical }, userId }
```

A post-hoc check is one early return away from being skipped, and by then the
row is already in memory.

A public id is a UUID *prefix*, so two rows can share one. `take: 2` turns that
into a refusal rather than into "the first match" — returning a ticket the user
did not name is worse than returning nothing.

Malformed, unknown, ambiguous and *someone else's* all produce the same answer.
A caller must not be able to learn from the difference whether a foreign ticket
exists.

## Idempotency

A browser retries: a flaky connection, a double tap, a reload of a hung submit.
Telegram's `sourceUpdateId` cannot help — there is no update — so the client
supplies one random id per explicit submission and reuses it for retries of
*that* submission.

`MiniAppRequestIdempotency` is keyed `@@unique([userId, clientRequestId])`.

- **Per user, never global.** Two strangers who draw the same value must not
  interfere, and a global namespace would also let anyone pre-claim keys and
  deny service to whoever drew one next.
- **Bound to the payload.** The row stores the operation, the target ticket and
  a SHA-256 fingerprint of the canonical normalized fields. A key replayed with
  different content is refused (`IDEMPOTENCY_CONFLICT`) rather than silently
  answering a question nobody asked.
- **Result references only.** Never the ticket text. It is already stored once;
  a second copy would double the blast radius of a leak for no benefit.

The fingerprint is length-prefixed per field (`${p.length}:${p}`), so no field
boundary can be shifted by content — the classic `"a" + "bc"` versus
`"ab" + "c"` collision.

**The unique index decides, not a lookup.** "Does this key exist?" before insert
races itself; the insert is attempted and the loser reads back the winner's row.

**Replay is resolved before preconditions.** A retry must return the original
result even after the world moved on. Re-checking first would turn a retried
create into `INVALID_SERVICE` after the linked Service was deleted, and a
retried reply into `TICKET_CLOSED` after an admin closed the ticket — both
false, since the ticket and the reply exist.

## Message history

Pages are read **backwards**: selected newest-first and reversed for display. A
conversation is read from its end, and selecting oldest-first would open a
ticket at its beginning and never reach the end in bounded time.

`limit + 1` rows are fetched, so "is there another page?" is answered by a row
that actually exists. Returning a cursor whenever `rows.length === limit` hands
out a cursor to an empty page exactly when the conversation length is a multiple
of the page size.

**Ownership is re-established on every page.** `listOwnedTicketMessages` takes a
`userId` and a *public* id and does the owner-scoped lookup itself; it does not
accept a `SupportTicket` object, because a plain row is not proof of anything —
any caller can construct one or carry it over from an earlier, unrelated check.
A cursor says where to continue. It never grants access.

## Notification intents

"Notify the admins" used to be a side effect performed after committing. That
works while the process writing the ticket is also the process that can reach
Telegram, and while nothing crashes in between. Neither holds any more: the API
has no bot token, and a crash between commit and send loses the notification
with nothing left to retry from.

So the **decision** to notify is recorded in the same transaction as the message
(`SupportNotificationIntent`), and **delivery** is a separate retryable step.

### Two levels, because one was wrong

The first version marked the whole intent `SENT` as soon as *any* administrator
was reached. With three administrators and two failing sends, the database said
delivered and the two who never heard about the ticket had no row anywhere
recording that. The contract is that **active administrators are notified**, not
that somebody was.

So `SupportNotificationIntent` is now only an aggregate, and
`SupportNotificationRecipient` carries one durable obligation per administrator.
A retry reaches the administrators who did not get it, and only those.

| Property | Guarantee |
| --- | --- |
| Intent write | Atomic with the message — both commit or neither |
| Delivery | At-least-once, **per recipient** |
| Fan-out | One obligation per active administrator, `@@unique([intentId, adminId])` |
| Duplicate suppression | The unique constraints plus a status-guarded claim at both levels |
| Successful recipient | Terminal — never claimed or sent again |
| Failed recipient | Exponential backoff, capped at 15 minutes, 6 attempts |
| Deactivated administrator | `SKIPPED` — terminal, not a failure |
| Stale claim recovery | `SENDING` older than 5 minutes returns to `PENDING`, recipients first |
| Intent completion | Only when **every** obligation is terminal |
| Exhausted | Parked as `FAILED` and kept, for an operator to find |

Exactly-once is not available across a process boundary and a third-party API:
the send happens either before the row is marked sent or after, and a crash in
that window picks the other failure. We mark *after* sending, so the window
produces a duplicate rather than a silent loss — telling one administrator twice
is recoverable, never telling them is not.

Two callers, one path. The handler that just wrote a ticket delivers
immediately — an admin waiting a sweep interval for a new ticket is a worse
product — and the sweep delivers whatever the immediate attempt did not. Both
claim first, so an overlap is a no-op rather than a duplicate.

### Why not `SystemLogDelivery`

That model is the right *shape* — one row per target, status-guarded claim,
attempts, backoff, `safeErrorCode`. But it is foreign-keyed to a `SystemLog` row
and its target is a `LogTopic` inside the Telegram log group. Reusing it would
mean fabricating a system log for every support ticket and modelling an
administrator as a topic. Both are lies that would then have to be maintained,
so the shape is copied and the model is not.

### The recipient set is frozen exactly once

Obligations are materialized when the intent is **first worked**, not when the
ticket is written — a ticket write must not depend on reading the administrator
table, and the API has no business knowing who the administrators are.

The expansion boundary is `recipientsExpandedAt` on the intent, and it is not
advisory: `freezeRecipientSet` stamps it with a compare-and-set on `NULL` and
inserts the recipient rows **in the same transaction**. That one decision
carries the whole contract:

- **Exactly once.** The CAS takes the intent's row lock, so two replicas
  expanding concurrently serialize on it; the loser's update matches zero rows
  and inserts nothing. One winner, one set, permanently.
- **Crash-consistent.** A failure after the stamp — the administrator read
  throwing, an insert violating a constraint, the process dying — rolls back
  the stamp *with* the partial rows. "At least one recipient row exists" was
  rejected as the completion signal precisely because a crash after a partial
  insert would make it lie.
- **No retroactive fan-out.** Once stamped, expansion is a permanent no-op:
  retries — including an operator re-driving a parked `FAILED` intent — never
  read the administrator table again. **An administrator added after the
  freeze receives no old event.** Promoting someone notifies them about what
  happens next, not about the backlog, and the delivered-set of an event stops
  depending on when the question is asked.

### No chat id is stored

The obligation points at the `Admin` row; the chat id is read from it at send
time and lives only in memory. Storing it would put it in every backup, every
query result and every dump of that table, and it would go stale.

### What may appear in a notification log

Only: the intent id, the stable event code, a classified failure code, an
attempt count, and aggregate counts.

Never: a raw Telegram error, a chat id, a username, a ticket subject, a ticket
message, attachment metadata, a full ticket uuid, or an administrator id.

A Telegram error string is arbitrary text written by a third party and can
contain any of those. Path-based redaction in the logger cannot help — it can
drop a field named `token`, but it cannot find an unknown substring inside a
field named `error`. So the raw error never reaches the logger at all;
`supportNotificationErrorCode` classifies it into one of `rate-limited`,
`blocked-by-admin`, `chat-missing`, `timeout` or `send-failed`, and that code is
what is stored and logged.

### Who runs delivery

The Bot process, started once from `apps/bot/src/index.ts` after the grammY
`Api` exists, after the database connection has been attempted and after the
shutdown handlers are armed. It runs one bounded tick immediately — a backlog
left by a process that died is exactly what a restart should clear, not
something to leave sitting for a full interval — and then sweeps every minute.

The API never imports grammY and never calls Telegram. It writes intents; the
Bot delivers them. That is the only reason an API-created ticket reaches an
administrator at all.

## What is not here

- No file bytes, object storage or base64. Attachments remain Telegram file
  references, and the bot remains the only surface that can send or retrieve
  them.
- No payments, wallet mutations, purchases or renewals.
- No user-side ticket closing, departments, SLAs or assignment.
- No realtime transport.
- Subjects and bodies are never logged.

## The recipient-set linearization point

The recipient set for a notification intent is **the set of administrators
eligible at the instant the freeze transaction takes its snapshot, which is the
eligibility query — the first statement of a REPEATABLE READ transaction.**

That sentence is the whole contract, and everything else follows from it:

- **One coherent snapshot.** PostgreSQL fixes a Repeatable Read transaction's
  snapshot at its first statement, and every later statement in that
  transaction reads from it. The eligibility query runs first, so the set is
  read once, at one instant, from one view of the database.
- **Committed after the snapshot means excluded.** An administrator created or
  activated after that instant is invisible to the whole transaction — to the
  compare-and-set, to the inserts, to everything.
- **Retries never widen.** A retry's compare-and-set finds
  `recipientsExpandedAt` already set and writes nothing, so the first winner's
  set is permanent. The administrator table is never re-read for a frozen
  intent.
- **Two expanders converge.** Exactly one transaction can move
  `recipientsExpandedAt` off NULL. A Repeatable Read loser raises a
  serialization failure instead of blocking; the freeze retries with a fresh
  snapshot up to five times, finds the intent frozen, and returns
  `{ frozen: false, created: 0 }`.
- **A failure leaves nothing behind.** The stamp and the obligations commit in
  the same transaction, so a throw anywhere rolls back both:
  `recipientsExpandedAt` stays NULL and zero recipient rows exist. "At least
  one recipient row" is deliberately *not* the completion signal — a partial
  insert would make it lie.
- **An empty set is a set.** No eligible administrator means the intent is
  frozen with zero obligations and completes, rather than looping forever.
- **No Telegram id is stored.** The obligation points at the `Admin` row; the
  chat id is read at send time and never written to the recipient table.

### Why the order changed

The previous implementation stamped `recipientsExpandedAt` first and read the
administrator table afterwards, then documented the stamp as the moment the set
froze. Under READ COMMITTED that was false: each statement takes a fresh
snapshot, so an administrator committing between the stamp and the read was
visible to the read and received an obligation for an event the code had
already declared sealed. The SQL was fine; the reasoning was wrong, which is
why tests that only checked the stamp kept passing.

The regression test now asserts the ordering from inside the transaction: at
the moment the eligibility snapshot is taken, `recipientsExpandedAt` must still
be NULL.

## Shutdown drains notification work

Stopping the sweep loop and disconnecting the database are two steps, and
between them there is a third: waiting. A sweep already running holds claims —
rows sitting in `SENDING` — and disconnecting underneath it strands every one
of them until the next process's stale recovery. So the controller exposes
`stop()` (idempotent, prevents new ticks) and `drain()` (resolves when no tick
is running), and shutdown runs, in order:

1. stop new support-notification ticks;
2. await the running sweep;
3. write the ops log, stop the bot and the queue consumers;
4. disconnect PostgreSQL.

Each step is awaited before the next begins and each is individually contained,
so a step that throws is logged and the sequence still reaches the disconnect.
The order is asserted by executing the sequence with a sweep that has not
resolved, not by reading the entrypoint as text.

## The Mini App Support Center HTTP surface

Six routes under `/api/miniapp`, all inside the authenticated plugin, all
owner-scoped in the query rather than filtered afterwards:

| Method | Path | Purpose |
|---|---|---|
| GET | `/support/summary` | counts for the landing page |
| GET | `/support/tickets` | the caller's tickets, newest activity first |
| GET | `/support/tickets/:ticketId` | one ticket, by public short id |
| GET | `/support/tickets/:ticketId/messages` | the thread, paged backwards |
| POST | `/support/tickets` | create a text-only ticket |
| POST | `/support/tickets/:ticketId/replies` | append a text-only reply |

**Identifiers.** No database uuid crosses this boundary. Tickets are addressed
by an 8-hex-character public id resolved through the domain's owner-scoped
resolver; a malformed, unknown, ambiguous or foreign id is the same 404, so the
response shape never confirms which ticket ids exist.

**Paging.** Sealed AES-GCM cursors bound to their collection —
`support-tickets` and `support-messages` are separate resources, so a cursor
from one cannot decode against the other, and neither can decode against
services or wallet transactions. A cursor says *where* to continue; the
session's user id says *whether* there is anything to continue.

**Text only.** There is no upload route, no attachment download and no file
metadata in any response — a message reports `hasAttachment: true` and nothing
more. Tickets raised from Telegram can carry files; the Mini App says one
exists and hands off to the bot. Adding a download here would mean deciding, in
a second place, who may read a file.

**The mutation gate**, in order, cheapest and most categorical first:

1. secure transport (plaintext refused in production);
2. same origin (checked before the rate limiter, so a cross-site flood cannot
   consume the victim's own quota);
3. `application/json` or 415 — a form post would otherwise parse as an empty
   body and reach the handler looking well-formed;
4. rate, per user **and** per client, both consumed on every attempt.

Body size is enforced by Fastify per route (8 KiB) before any of it runs.

`MINIAPP_SUPPORT_RATE_LIMIT` sets the per-user per-minute ceiling (default 10,
clamped, never throwing); the per-client ceiling is three times it, so raising
one cannot be silently capped by the other.

**Errors** are codes, never prose: the domain's own `SupportDomainError` maps
to a status in the domain package (`supportDomainErrorStatus`), so `400`
(malformed), `404` (no such ticket for this owner) and `409` (`TICKET_CLOSED`,
`IDEMPOTENCY_CONFLICT`) mean the same thing on every transport. A closed ticket
is deliberately distinguishable from a missing one: the Mini App has to tell
"this conversation is over" apart from "no such ticket".

**Idempotency.** Every mutation carries a `clientRequestId`; replaying it
returns the original ticket, and reusing it with a different payload is a
409 rather than a silent second write.

**The API still cannot reach Telegram.** Creating a ticket writes a
notification intent in the same transaction as the message; the bot's sweep
turns that into a message to the administrators. This is why the intent exists.
