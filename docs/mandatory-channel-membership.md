# Mandatory Channel Membership (Force Join)

When enabled, users must be live members of every configured active channel
before they can use the bot. This document describes the data model, the admin
configuration flow, the runtime membership gate, and the operational behaviour.

## Overview

- **Master switch:** the existing `force_join_enabled` Setting (reused, not
  duplicated). When `false`, no membership checks run.
- **Channels:** stored in the `ForceJoinChannel` table, configured entirely from
  admin-supplied **links** — an admin never types a numeric chat id.
- **Gate:** integrated into `ensureUserAccess`, preserving the order
  `maintenance → blocked → terms → force-join → normal`.
- **Membership is live state** — there is no "verified once" flag and no stored
  `joinedAt`; every gated interaction re-checks the current membership (cached
  briefly). `User.forceJoinBypass = true` skips the whole check.

## Data model

`ForceJoinChannel` (migration `20260725190000_force_join_channels`):

| Field | Notes |
| --- | --- |
| `id` | uuid, carried (as an 8-char prefix) in admin callback data |
| `title` | visible channel title captured at resolution (safe to show) |
| `joinUrl` | buyer-facing join URL (public: `https://t.me/<username>`; private: the invite link, preserved verbatim) |
| `normalizedLink` | dedup / identity key (public: normalized `https://t.me/<lower-username>`; private: the invite link) |
| `chatId` (BigInt) | internal Telegram peer id — **globally unique** (D5), never shown to users/admins/logs |
| `publicUsername` | lower-cased username without `@` (public only) |
| `isPrivate`, `isActive`, `sortOrder` | |
| `createdByAdminId` | soft reference |
| `lastValidatedAt`, `lastValidationErrorCode` | last bot-access validation result (normalized error class only) |

Health columns (migration `20260726120000_force_join_link_unique_and_health`):
`healthFailureCount`, `healthFailureFirstAt`, `healthFailureLastAt`,
`unhealthyAt` — see [Unhealthy-channel lifecycle](#unhealthy-channel-lifecycle-411).

Constraints:

- `chatId` is **globally unique** — re-adding the same channel updates the
  existing row rather than inserting a duplicate (D5).
- `normalizedLink` is **globally unique across public AND private rows**
  (migration `20260726120000_force_join_link_unique_and_health` replaced the
  original public-only partial index). Two rows may never advertise the same
  join target: a user shown one link must map to exactly one configuration row,
  otherwise the channel they join and the channel the gate verifies can differ.
- Ordering is deterministic: `(sortOrder ASC, createdAt ASC, id ASC)`. There is
  no `UNIQUE(sortOrder)`; reordering renumbers `sortOrder` contiguously.

Both migrations are forward-only; the original
`20260725190000_force_join_channels` is never modified. The link-uniqueness
migration runs a **privacy-safe preflight** first: it counts duplicated
`normalizedLink` groups and aborts with only that COUNT in the error message —
never a link, invite hash, chat id or row id, because migration errors surface
in deployment logs. Existing installs keep the `force_join_enabled` Setting, the
`force_join_text` template, and `User.forceJoinBypass`.

### Serialized configuration mutations

Every mutation that reads-then-writes the active set, the 10-active cap, the
`sortOrder` allocation or the master switch first takes ONE dedicated
transaction-level advisory lock (`pg_advisory_xact_lock(hashtext(
'zedbot-force-join-config'))`): create/rebind, link+identity update,
activate/deactivate, delete, enable/disable and the combined D3 actions,
and reorder.

A row lock on the active set (`… WHERE "isActive" = true FOR UPDATE`) cannot
serialize these, because when the active set is **empty** it locks no rows at
all — two concurrent "create the first channel" or "enable" transactions would
both observe zero and both commit. The advisory lock exists independently of any
row and releases on commit/rollback. `force-join-concurrency.test.ts` drives real
parallel transactions and fails without it.

## Link parsing (no SSRF)

`parseForceJoinLink` (in `@zedbot/shared`) is pure string logic — it **never**
issues a network request. It accepts:

- public: `https://t.me/<username>`, `https://telegram.me/<username>`,
  `t.me/<username>`, `@<username>`
- private: `https://t.me/+<hash>`, `https://t.me/joinchat/<hash>`

and normalizes public links to `https://t.me/<lower-username>` while preserving a
private invite hash byte-for-byte. It **rejects** external URLs, message links
(`t.me/x/123`), deep links (`t.me/proxy?…`, `t.me/share?…`, `tg://…`), reserved
paths (`s/`, `c/`, …), and any input containing control, zero-width, bidi, or
non-ASCII (homoglyph) characters — rejected, never "cleaned". The parser only
guarantees a *structurally* valid channel/invite link; whether the target is
actually a channel (vs a bot/user/group) is asserted later by Telegram at
`getChat` (§4.2).

## Internal identity resolution & bot-permission validation

At channel creation, activation, and on the "تست دسترسی ربات ♻️" action, the bot
runs `getMe → getChat → getChatMember(channel, botId)` (T9 order) and asserts the
bot is `administrator` or `creator` (D1). On failure it returns exactly:

```
ابتدا ربات را در کانال ادمین کنید و دوباره تلاش کنید.
```

- **Public channel:** the username is resolved via `getChat('@username')`; the
  **authoritative** username/title from `getChat` are persisted (not the admin's
  typed casing — T4).
- **Private channel:** an invite link is not a resolvable identity. The admin
  pastes the invite link (validated and held in session), the bot presents a
  `request_chat` channel picker (a temporary reply keyboard — request_chat only
  works there, not on an inline keyboard — T1/T2), the admin selects the channel,
  and the bot re-validates the resulting `chat_shared` via `getChat` +
  `getChatMember` before pairing it with the stored invite link. The
  `request_chat` `request_id` is a **cryptographically random positive 32-bit
  integer generated per picker operation** (`randomInt`), session-bound,
  single-use, sender-checked and time-limited (T3). It is never derived from the
  sender id: a predictable value could be replayed or crafted to satisfy a
  picker the OWNER did not arm, and a per-user-constant value would let an old
  `chat_shared` answer a newly armed flow.

### Private link and identity are inseparable

For a private channel the invite link proves nothing about which channel it
opens, so the service exposes **no primitive that moves one without the other**.
`rebindChannelIdentity` takes the identity *and* the link as required parameters
and writes them in a single statement; there is no "update just the link".

Both «ویرایش لینک» and «انتخاب مجدد کانال» therefore run the same combined,
session-bound operation on a private row:

1. the OWNER submits a **fresh invite link** — validated and held in session,
   nothing persisted yet;
2. a **fresh `request_chat` picker** opens (new random `request_id`);
3. the OWNER selects the channel;
4. the bot re-validates `getChat` + `getChatMember` and asserts admin/creator;
5. identity (`chatId`/title/private flags) **and** `joinUrl`/`normalizedLink`
   are written atomically;
6. a duplicate identity is refused as `DUPLICATE_CHANNEL`, a duplicate link as
   `LINK_CONFLICT`.

This makes all three broken states unreachable, each covered by a test: link A
with identity B, an old invite link with a newly rebound channel, and a newly
edited link with the old channel identity.

For a **public** row the link resolves to an identity, so the edit is applied
directly — but only when it resolves to the SAME channel; a link pointing at a
different channel is rejected (use «افزودن کانال» instead).

## Admin UI

Under `تنظیمات عمومی ⚙️`, section **`عضویت اجباری 📢`** (OWNER only; other roles
fail closed). Routing uses stable `admin:force_join:*` callbacks carrying the
channel id's short prefix — never a chat id, username, link, or Persian label.

Actions: enable / disable force join, add channel, edit link, re-pick channel
(private), test bot access, activate/deactivate, move up / move down, delete
(with confirmation). A maximum of **10 active channels** is enforced in the
service layer; an 11th channel is stored inactive rather than rejected.
Activating an inactive channel **re-validates bot access first** (getMe →
getChat → getChatMember) and refuses the transition if the bot is no longer an
admin, so the overview can never advertise a required channel that membership
evaluation would silently exclude as unverifiable. A successful **تست دسترسی
ربات ♻️** clears any previously-recorded validation error. The overview is
**paginated in the database** (`skip`/`take`, 8 rows per page, with the page rows
and both counts read in one transaction). Only ACTIVE channels are capped, so the
inactive tail is unbounded: it must never be loaded into memory to render a page,
nor be allowed to overflow Telegram's message / keyboard limits.

Text entry uses session-bound flows; `انصراف`, `/admin`, `/start`, `/ping`,
`/paysupport`, and navigation unwind the flow safely and remove any temporary
reply keyboard — even for a command whose own handler is registered ahead of the
admin flow dispatcher (an early escape middleware clears the flow first). The
private-channel `request_chat` picker is only offered in a **private chat** with
the bot (Telegram forbids `request_chat` keyboards in groups); an attempt from a
group is rejected with a "use the bot's private chat" notice instead of stranding
the session in the picker flow. Editing a **public** channel's link adopts the
freshly-validated username/title only when it resolves to the **same** channel; a
link pointing at a different channel is rejected (use «افزودن کانال» to add a new
one) so the gate and the join screen can never diverge.

## Runtime gate & user screen

When `force_join_enabled` is on and the user is not bypassed, `ensureUserAccess`
reads the active-channel set **once** (§4.13) and evaluates membership:

- **Joined** in every active channel → the user proceeds.
- **Missing** one or more → the user sees the join screen: a header, one URL
  button per **missing** channel labelled `عضویت در <title>` (title escaped /
  truncated), a `بررسی عضویت ✅` check button, and an optional support row. The
  Telegram chat id never appears in the text, buttons, or callback data.
- **Temporary/network failure** → the gate fails closed without lying, showing:
  `بررسی عضویت موقتاً ممکن نیست. چند لحظه دیگر دوباره تلاش کنید.` (D2). The admin
  area stays reachable so an OWNER can repair the configuration.

Tapping `بررسی عضویت ✅` re-checks live membership (bypassing the negative cache),
debounced per user. On success it answers `عضویت شما تایید شد ✅` and shows the
normal menu — nothing about balance, orders, referral, or payment state changes.

### Stale check keyboards

The check button lives on a message that can be arbitrarily old, so before the
handler spends anything it re-derives the current world, in order:

1. `ensureUserAccess` — registers/loads the user and applies maintenance →
   blocked → terms (it deliberately skips its own force-join gate for this
   callback, which is what the handler is performing);
2. the `force_join_enabled` master switch and the per-user `forceJoinBypass`;
3. the live active-channel snapshot (read once, reused by the gate — §4.13).

If force join is off, the user is bypassed, or there are zero active channels,
the tap makes **no Redis call, takes no debounce slot and issues no
`getChatMember`** — the user is simply returned to the normal menu. Only a tap
that genuinely still requires verification reaches Telegram.

### Membership status rule (§4.8)

Joined: `creator`, `administrator`, `member`, and `restricted` **only when**
`is_member === true`. Not joined: `left`, `kicked`, `restricted` without
`is_member`, and user/chat-not-found. A pending join request is **not**
membership.

## Enabled-state safety (never brick — D4)

- Disabled → no checks.
- Enabled + **zero active valid channels** → everyone passes. Enabling with no
  active channel is rejected with exactly:
  `ابتدا حداقل یک کانال معتبر و فعال اضافه کنید.`
- Removing/deactivating the **last active channel while enabled** is rejected;
  the admin is offered a combined atomic "disable force join + deactivate/delete"
  action (D3).

## Failure taxonomy & alerts (§4.11)

`classifyMemberCheckError` is ordered so the **safe** answer always wins. Only
`NOT_JOINED` blocks a real user, so it is the one verdict that is never guessed:

1. **`TEMP`** — 429, 5xx, and any error without an API code (network / timeout /
   abort). Fails closed without lying (D2).
2. **`UNVERIFIABLE`** — bot removed / demoted / kicked, `member list is
   inaccessible`, `chat not found`, `not enough rights`, `CHANNEL_PRIVATE`,
   `PEER_ID_INVALID`, any `Forbidden:`. Checked **before** any user-absence
   match, because several of these descriptions also mention the
   member/participant and must never be read as "this user did not join".
3. **`NOT_JOINED`** — only a narrow, explicit user-not-a-participant wording:
   `USER_NOT_PARTICIPANT`, `user is not a participant`,
   `PARTICIPANT_ID_INVALID`.
4. **anything else 4xx → `UNVERIFIABLE`** (fail safe).

Deliberately *not* treated as user-absence: the bare substring `participant`
(it matches access errors) and `user not found` (Telegram not knowing an account
is not proof they left the channel). Both fail safe instead of locking out a
genuine member.

An unverifiable channel is **excluded** from gating (users are never bricked) and
raises a durable, privacy-safe OWNER alert (`writeSystemLog`, event
`force_join.channel_unverifiable`, SYSTEM topic), deduplicated per channel per
rolling window (Redis, with a process-local fallback). Logs carry only the
channel DB id, a normalized error class, and the `isPrivate` flag — never the
chat id, invite link, API token, or raw Telegram response.

## Unhealthy-channel lifecycle (§4.11)

Excluding a broken channel forever would leave the admin panel advertising a
required channel that is not actually enforced. So permanent failures are counted
durably and the channel is eventually retired — bounded, and never at the cost of
locking users out.

| Rule | Value |
| --- | --- |
| Failure threshold | **5** consecutive permanent unverifiable results (`FORCE_JOIN_HEALTH_FAILURE_THRESHOLD`) |
| Sustained window | **10 minutes** — the failures must also have persisted this long (`FORCE_JOIN_HEALTH_MIN_WINDOW_MS`) |
| Window restart | a failure **more than 60 min** after the previous one starts a fresh window (`FORCE_JOIN_HEALTH_RESET_MS`) |
| Count debounce | at most one increment per channel per **5 s** (`FORCE_JOIN_HEALTH_COUNT_DEBOUNCE_MS`) |

- **Transient** (`TEMP`) results never mutate configuration and never count.
- Each **permanent** result increments the durable counter (write-debounced, so a
  broken channel costs O(1) writes per interval rather than one per gated user).
- Once the count reaches the threshold **and** the window has elapsed, the
  channel is atomically deactivated (`isActive = false`, `unhealthyAt` set).
- If it was the **last active channel while force join was enabled**, the master
  switch is disabled in the **same transaction** — the bot is never left switched
  on with nothing enforceable.
- Retirement emits `force_join.channel_auto_deactivated` (SYSTEM topic, ERROR)
  carrying only the channel DB id, `isPrivate`, `errorClass`,
  `forceJoinDisabled`, and the threshold/window values. When the retirement also
  switched mandatory membership off, a **second** event
  `force_join.auto_disabled` is emitted: losing the whole feature is a different
  operational fact from losing one channel, and an operator may filter, alert on
  or escalate the two differently. The recurring unverifiable alert stays
  deduplicated; the one-shot retirement alerts are not.

### Why the retirement alert is an outbox row, not a sink call

The unhealthy-channel policy lives in `@zedbot/force-join` and is reached from
**both** the bot and the API — a Mini App request runs the same gate. Only the
bot owns the Telegram delivery queue, so an alert emitted *after* the mutation
by whichever process installed an alert sink is missing in exactly the case that
matters most: an API request quietly deactivating a required channel, or
switching mandatory membership off for the whole platform, with nothing but a
line on that process's stdout.

So the retirement events are written as **outbox rows on the same transaction as
the configuration change** (`packages/force-join/src/ops-outbox.ts`): a
`SystemLog` row plus, when a delivery target is configured, its `PENDING`
`SystemLogDelivery`.

- They commit with the retirement or do not exist at all — no unannounced
  automatic configuration change, and no alert about a change that rolled back.
- A crash a millisecond after `COMMIT` loses nothing: the row is already durable.
- Telegram is never called on the request path, so a delivery failure cannot
  roll back or delay the membership decision.
- Idempotency comes from the mutation itself: a retry re-reads the row, finds it
  already inactive, and returns before reaching the write.

The **worker** delivers them through the existing `SystemLog` →
`SystemLogDelivery` → Telegram pipeline. Because a writer with no BullMQ
connection cannot enqueue, `apps/worker/src/log-delivery-sweep.ts` re-enqueues
owed rows on a fixed cadence.

### What delivery actually guarantees

Three different guarantees live in this pipeline and they are not the same
strength. Conflating them is how an operator ends up either trusting a lost
alert or filing a bug about a duplicate one.

| Stage | Guarantee | Why |
| --- | --- | --- |
| Durable record | **One** per committed retirement | The outbox row is written on the configuration transaction. It cannot exist without the retirement, and the retirement cannot commit without it. |
| Job creation | **Idempotent** | The job id is derived from the delivery id (`logdel-<id>`), so re-enqueuing something already queued or delayed is a no-op. |
| Terminal deliveries | **Never intentionally retried** | `SENT`, `DEAD_LETTER` and `SKIPPED` are excluded from the sweep, and the processor returns early on them. |
| Telegram send | **At-least-once** | See below. A single Telegram message per alert is not promised. |

The sweep recovers owed rows on this rule, and nothing else:

| Status | Selected when | Reasoning |
| --- | --- | --- |
| `PENDING` | `createdAt` older than 30 s | Committed but, as far as we can tell, never enqueued — the API's outbox, or a crash between `COMMIT` and enqueue. The grace period keeps it from racing the writer that is enqueuing right now. |
| `FAILED` | `nextAttemptAt` is due | A retry whose delayed job lived only in Redis. If that job still exists the id dedupe makes this a no-op. |
| `SENDING` | `updatedAt` older than **10 minutes** | An abandoned claim: the worker died or Redis lost the job mid-send. |
| `SENT` / `DEAD_LETTER` / `SKIPPED` | never | Terminal. |

`SENDING` is keyed on `updatedAt` — the claim time — and never on `createdAt`,
because a long-queued alert claimed one second ago is exactly the row that must
not be disturbed. Ten minutes is an order of magnitude past any legitimate
claim: the processor's Telegram call is hard-bounded by an AbortController at
`TELEGRAM_API_TIMEOUT_MS`, whose ceiling is 60 s.

**Why at-least-once, and no stronger.** If the worker dies after Telegram
accepted the message but before the `SENT` status commits, the row is still
`SENDING`. Ten minutes later the sweep hands it back and the message is sent a
second time. That window cannot be closed — Telegram is not part of our
transaction — so the honest statement is that an operational alert may arrive
twice, and the system prefers that to losing one. The sweep itself never calls
Telegram; it only re-enqueues, and the processor remains the sole owner of
claiming, sending and status transitions.

The process-local **alert sink** still exists, but only for the pre-retirement
`force_join.channel_unverifiable` warning, which changes no configuration. The
bot installs a sink that writes a `SystemLog`; the API keeps the package's
logging default. That output is supplemental — it is never the authoritative
record of a configuration change.

**Recovery.** Re-grant the bot admin rights in the channel, then either press
«تست دسترسی ربات ♻️» or re-activate the channel — both re-validate, and a
success on a **still-active** channel clears
`healthFailureCount`/`healthFailureFirstAt`/`unhealthyAt`, so a repaired outage
can never combine with a later one to cross the threshold. Activation
additionally refuses to turn a still-inaccessible channel back on. A successful
membership check clears the window on its own, guarded on the in-memory snapshot
so healthy channels cost no extra writes on the hot path.

**A success can never un-retire a channel, or erase the record of one.** The
clearing update takes the same Force Join configuration advisory lock the
retirement takes, and is additionally conditioned on `isActive: true`:

| Order | Outcome |
| --- | --- |
| success commits first | the window is legitimately cleared; the retirement re-reads a healthy channel and declines |
| retirement commits first | the success matches no row — the counters and `unhealthyAt` stay exactly as retirement left them |

Without the lock the two writers could interleave; without the `isActive` guard
a check that started before a retirement and landed after it would wipe the very
evidence an operator reads when judging whether the retirement was justified.
`isActive` is not in that update's `data` at all, so this path can only ever
write *less* — it cannot reactivate anything.

## Caching (§4.12)

Membership verdicts are cached in Redis, bounded:

- joined → ~90s TTL, not-joined → ~10s TTL, API errors → never cached.
- Cache keys include the user id (string), the channel DB id, and the channel
  version (`updatedAt`), so any activation, edit, rebind, or deletion invalidates
  naturally. The `BigInt` chat id is never placed in a key (T6).
- Redis down → the cache is bypassed and Telegram is queried directly; a cache
  failure never fails the membership check (D8).
- The explicit `بررسی عضویت ✅` re-check bypasses the negative cache.

## Compatibility

- `User.forceJoinBypass` still bypasses the whole check.
- `force_join_enabled` is reused (not duplicated); `force_join_text` remains
  operator-editable. The join-page header is a new operator-editable
  `force_join_page` template defaulting to the §4.9 header.
- The terms flow and `/start` referral handling are unchanged. No existing user
  is auto-bypassed or permanently marked joined (D9).

### Interaction with the free-trial channel-membership option

The free-trial eligibility calculator has a **separate**, admin opt-in setting
(`freeTrialRequiresChannelMembership`) that predates this feature and denies a
trial when `force_join_enabled` is on and the user is not bypassed. It is a
coarse flag check, not a live membership check. Because the real force-join gate
now enforces membership **before** any user can reach the trial flow, that
option is redundant when force join is globally enabled. It is intentionally left
unchanged (no scope creep); operators who rely solely on the new gate can leave
`freeTrialRequiresChannelMembership` disabled.
