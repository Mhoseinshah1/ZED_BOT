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

| Property | Guarantee |
| --- | --- |
| Intent write | Atomic with the message — both commit or neither |
| Delivery | At-least-once |
| Duplicate suppression | `@@unique([messageId, kind])` plus a status-guarded claim |
| Stale claim recovery | `SENDING` older than 5 minutes returns to `PENDING` |
| Retry | Exponential backoff, capped at 15 minutes, 6 attempts |
| Exhausted | Parked as `FAILED` and kept, for an operator to find |

Exactly-once is not available across a process boundary and a third-party API:
the send happens either before the row is marked sent or after, and a crash in
the gap picks the other failure. Telling support twice about one ticket is
recoverable; never telling them is not.

Two callers, one path. The handler that just wrote a ticket delivers
immediately — an admin waiting a sweep interval for a new ticket is a worse
product — and the sweep delivers whatever the immediate attempt did not. Both
claim first, so an overlap is a no-op rather than a duplicate.

Intents carry **references only**. Rendering reads the ticket at delivery time,
so a subject is never copied into a second table and a retry describes the
ticket as it is rather than as it was.

`safeErrorCode` stores a short scrubbed marker (`rate-limited`,
`blocked-by-admin`, `chat-missing`, `timeout`, `send-failed`) — never a Telegram
payload, never ticket text.

## What is not here

- No file bytes, object storage or base64. Attachments remain Telegram file
  references, and the bot remains the only surface that can send or retrieve
  them.
- No payments, wallet mutations, purchases or renewals.
- No user-side ticket closing, departments, SLAs or assignment.
- No realtime transport.
- Subjects and bodies are never logged.
