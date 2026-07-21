# ZED_BOT support tickets (Phase 32)

Phase 32 replaces the placeholder «پشتیبانی» page with a structured,
text-only ticket system: users open tickets and reply, admins answer and
close, both sides get notified. Ticket tables are the only thing written —
no payment/order/service/provisioning logic changed, no financial rows
mutated, no Service rows.

Source: `apps/bot/src/services/support-ticket.service.ts`, user UI in
`apps/bot/src/handlers/user-support/support.handler.ts`, admin UI in
`apps/bot/src/handlers/admin-support/support-admin.handler.ts`.

## Schema — migration `20260710172031_support_tickets_phase32`

The schema already had `SupportTicket`/`SupportMessage` (from the initial
baseline), so the migration extends them minimally instead of adding
parallel models: `SupportTicketStatus` gains **WAITING_ADMIN** and
**WAITING_USER** (`ANSWERED` stays as a legacy value, treated like
WAITING_USER in filters), `SupportMessageSenderType` gains **SYSTEM**,
`SupportTicket` gains `closedByAdminId` (+ named relation
`SupportTicketClosedBy` to Admin) and the `[userId, updatedAt]` /
`[status, updatedAt]` indexes for the list sort. `SupportMessage.fileId`
exists but stays unused (no attachments in this phase).

## Statuses and transitions

- **create** → ticket `WAITING_ADMIN` + first USER message (one
  transaction).
- **user reply** (refused on CLOSED) → USER message + status
  `WAITING_ADMIN`.
- **admin reply** (refused on CLOSED) → ADMIN message + status
  `WAITING_USER`.
- **close** (refused when already CLOSED — safe repeated close) → status
  `CLOSED` + `closedAt` + `closedByAdminId` + one SYSTEM message
  «تیکت بسته شد.».

Every transition is a status-guarded `updateMany` inside a transaction, so
a stale button or a concurrent close can never double-write. Validation:
subject 3..100 chars, message 1..3000 chars (trimmed).

## User path

منوی اصلی → «پشتیبانی ☎️» (`user:support`, same button — the placeholder
page is gone; the operator-editable `support_text` template still shows on
the landing). Landing buttons: «تیکت جدید ➕» (`user:sup:new`, flows
`support:subject` → `support:message`), «تیکت‌های من 🧾»
(`user:sup:list:<page>`), «بازگشت به منو». List rows:
`⏳|💬|🟡|✅ subject | MM-DD|بسته`, newest activity first, 10/page. Detail
(`user:sup:view:<sid>`): short id, subject, status, dates and the last 10
messages (👤 شما / 👨‍💼 پشتیبانی / ⚙️ سیستم, each previewed at 300 chars so
the message stays under Telegram's 4096 limit) plus «پاسخ دادن ✍️»
(`user:sup:reply:<sid>`, flow `support:reply`) while not CLOSED.
`/`-commands cancel flows; «انصراف» buttons return to the landing/detail.

## Admin path

پنل مدیریت 🛠 → **«تیکت‌های پشتیبانی 🎫»** (`admin:support`, new main-menu
button). Landing shows باز / در انتظار ادمین / در انتظار کاربر / بسته‌شده
counters with filter buttons (`admin:sup:list:<open|waiting_admin|
waiting_user|closed>:<page>`; `open` = OPEN+WAITING_ADMIN+WAITING_USER
(+legacy ANSWERED), `waiting_admin` includes legacy OPEN rows). Detail
(`admin:sup:view:<sid>`): user telegram id/username, subject, status,
created/updated/closed (+closing admin short id), last 10 messages, and —
while not CLOSED — «پاسخ دادن ✍️» (`admin:sup:reply:<sid>`, flow
`admin_support:reply`) and «بستن تیکت ✅» (`admin:sup:close:<sid>` →
confirmation → `admin:sup:close_yes:<sid>`). `showAdminMenu` clears both
support states like every other wizard.

## Notifications (fault-isolated, never roll back a ticket write)

- new ticket → every ACTIVE admin: «🎫 تیکت جدید» + short id + user +
  subject + «مشاهده تیکت 🎫» (`admin:sup:view:<sid>`).
- user reply → active admins: «💬 پاسخ جدید کاربر در تیکت» (same shape).
- admin reply → the ticket owner: «پاسخ پشتیبانی ارسال شد 💬» + subject +
  «مشاهده تیکت 🎫» (`user:sup:view:<sid>`).
- close → the owner: «تیکت شما بسته شد ✅».

Per-recipient try/catch; failures log ids only. Notifications are plain
text (no parse mode), so user-provided subjects cannot inject markup.

## Security / owner scope

User detail/reply/list queries always filter on the owner's `userId`;
admins see all tickets. Short ids follow the take-2 single-exact-match
rule (`[0-9a-f-]{4,32}`), all rendered text is HTML-escaped, and only
8-char short ids are ever displayed.

## Testing

`apps/bot/tests/support-tickets.test.ts`: create (WAITING_ADMIN + first
USER message), subject/message validation bounds, owner-scoped list and
detail (foreign user gets null), user reply on closed refused / on open
moves to WAITING_ADMIN, admin reply moves to WAITING_USER and is refused
after close, close sets CLOSED/closedAt/closedByAdminId + SYSTEM message
and a repeated close fails safely, admin filters return only their
statuses, gibberish short ids fail, notifications reach active-but-not-
inactive admins with the view button and one blocked admin doesn't stop
the rest, user notifications carry the subject, and the message preview
truncation.

## Intentionally NOT implemented

File/photo/voice attachments (`fileId`/media stay unused), departments/
categories, SLA/priority, per-admin assignment, unread counters, user-side
close, broadcast, email/Slack, web panel, mini app, Phase 33+.

## Service diagnostics attachment (feat/service-self-diagnostics)

`SupportTicket` gained two additive, nullable fields (migration
`20260721154237_service_self_diagnostics_support_link`): `serviceId` (owner-scoped
relation, `ON DELETE SET NULL`, indexed) and `diagnosticSnapshot` (a strict,
bounded, secret-free JSON snapshot). Every ordinary ticket keeps both `null`.

`createSupportTicket(userId, subject, messageText, attachment?)` takes an optional
`{ serviceId?, diagnosticSnapshot? }`. The diagnostics handoff seeds the EXISTING
support MESSAGE flow; when the user sends their message, the support text handler
re-resolves ownership (`getOwnedServiceById`) and re-validates the snapshot
(`validateDiagnosticSnapshot`) before attaching — a stale/foreign context is
silently dropped and a normal ticket is still created. The admin ticket detail
renders the safe diagnostic summary (overall/evidence/checkedAt + stable codes in
Persian) and a jump to the user's existing services list; no Service
administration is duplicated in the ticket page. See
`docs/service-self-diagnostics.md`.
