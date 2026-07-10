# ZED_BOT admin text broadcast (Phase 33)

Phase 33 adds a controlled, **text-only** announcement system: an admin
writes a message, picks a simple audience, test-sends it to themselves,
confirms, and the bot delivers it with per-recipient result rows and a
progress view. Broadcast tables are the only writes — no
payment/order/service/provisioning/support logic changed, no financial
rows mutated, no Service rows.

Source: `apps/bot/src/services/broadcast.service.ts`, UI in
`apps/bot/src/handlers/admin-broadcast/broadcast.handler.ts`.

## Schema — no migration

The baseline schema already contains `Broadcast` / `BroadcastRecipient`
and their enums, so Phase 33 adapts to them: the audience key is stored in
`Broadcast.targetFilter` (`{"audience": "..."}`), the text in
`messageText`, counts in `totalTargets`/`sentCount`/`failedCount`/
`skippedCount`, per-recipient results in `BroadcastRecipient`
(`status`/`errorMessage`/`sentAt`, unique `[broadcastId, userId]`).
`type` is always SEND; FORWARD, `pinMessage`, `sourceChatId/MessageId` and
recipient `pinStatus` stay unused. There is no broadcast-level
errorMessage column — catastrophic failures set status FAILED and log the
reason (ids + short error only).

## Admin path

پنل مدیریت 🛠 → **«پیام همگانی 📣»** (`admin:broadcast`, new main-menu
button). Landing: «ساخت پیام جدید ➕» (`admin:bc:new`), «لیست ارسال‌ها 🧾»
(`admin:bc:list:<page>`), back. Flow: text (`admin_broadcast:text`, 1..3500
chars, `/`-commands cancel) → audience picker with live estimates
(`admin:bc:aud:<audience>`; the draft is consumed before the DB row is
created, so a double-clicked audience button cannot create two drafts) →
preview/detail with «ارسال تستی به من 🧪» (`admin:bc:test:<sid>`), «شروع
ارسال نهایی 🚀» (`admin:bc:start:<sid>` → confirmation →
`admin:bc:start_yes:<sid>`) and back. `showAdminMenu` clears the flow and
draft. Admin-only via the existing middleware plus per-route checks
(user callbacks cannot reach `admin:*` routes at all).

## Audiences (Phase 33 keeps it simple — no arbitrary filters)

Every audience is limited to `User.status = ACTIVE` — blocked/disabled/
deleted accounts never receive broadcasts.

| key | rule |
| --- | --- |
| `all_active` | همه کاربران فعال |
| `active_services` | ≥1 Service with status ACTIVE or LIMITED |
| `buyers` | ≥1 Order with status PAID or COMPLETED |
| `no_purchase` | active users with **no** PAID/COMPLETED order |
| `test_only` | no final recipients — final start is refused |

## Draft / test / final send

- **Draft** — `createBroadcastDraft` validates text (trimmed, 1..3500) and
  audience, then creates a CONFIRMING broadcast. Nothing is sent.
- **Test send** — sends the exact text to the requesting admin's own
  telegram id; creates **no** recipient rows and changes no status;
  allowed only while DRAFT/CONFIRMING.
- **Final start** (`startBroadcast`) — refused for `test_only`; a
  status-guarded `updateMany` (DRAFT/CONFIRMING → RUNNING + startedAt)
  means **only the first click starts the send** — a double click gets
  «این ارسال قبلاً شروع شده است.» and nothing is re-sent. Then: audience
  snapshot → `createMany` PENDING recipients with `skipDuplicates` (the
  `[broadcastId, userId]` unique = at most one row, so at most one send,
  per user per broadcast) → `totalTargets` set → sequential sends in
  batches of 25 (rate-safety), each recipient marked SENT+sentAt or
  FAILED+short safe errorMessage, with the broadcast counters updated per
  batch → COMPLETED + completedAt. One failed recipient never stops the
  loop; a catastrophic exception marks the broadcast FAILED (no automatic
  retry).

**Synchronous send warning:** the loop runs inside the callback handler.
At this bot's scale that is acceptable (documented spec trade-off); the
callback is answered *before* the loop starts and the RUNNING detail has a
«به‌روزرسانی وضعیت 🔄» refresh button. A worker-based queue is the natural
later upgrade.

**Plain text on purpose:** outgoing broadcasts use no parse mode, so
nothing in the admin's text can inject markup; only the on-screen preview
is HTML-escaped.

## List / detail / progress

List: newest first, 10/page, rows
`📝|⏳|✅|❌ audience | sent/total | MM-DD|در حال ارسال`. Detail: short id,
status, audience, estimate (while confirming) or
گیرندگان/ارسال‌شده/ناموفق/در صف/ردشده (from `getBroadcastProgress`, which
counts the recipient rows live), created/started/completed timestamps and
the escaped text preview (800-char cap). Buttons are state-gated: test +
start only for DRAFT/CONFIRMING (start hidden for `test_only`), refresh
only while RUNNING.

## Safety / security

Admin-only end to end; non-ACTIVE users always excluded; per-recipient
failures log `broadcastId`/`userId`/short error only — **never the
broadcast text**; recipient `errorMessage` stores a 200-char cap, no stack
traces; only 8-char short ids in the UI (take-2 lookup rule); no
payments/orders/services/support tickets mutated.

## Testing

`apps/bot/tests/broadcast.test.ts`: audience estimates (delta-based on the
shared DB — active counted, blocked excluded; buyers vs no_purchase;
ACTIVE/LIMITED services counted, EXPIRED not); draft validation (length,
audience) and stored fields; test send reaching exactly the admin with the
exact text and zero recipient rows; full `startBroadcast` run over a
recorder (recipient snapshot, exactly one send per target user, FAILED
marking with safe errorMessage for a blocked recipient, counters and
COMPLETED status, progress figures); double start refused with zero
additional sends; `test_only` final start refused with nothing created;
newest-first pagination; gibberish short ids failing.

## Intentionally NOT implemented

Photo/video/document broadcasts, FORWARD mode, pinning, scheduling,
recurring campaigns, segmentation builder, A/B testing, cancel-while-
running, background/worker queue (synchronous send documented above),
web panel, mini app, Phase 34+.
