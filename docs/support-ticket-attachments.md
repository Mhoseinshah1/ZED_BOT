# Support Tickets V2 — service-linked tickets & secure attachments

Support Tickets V2 is an **additive upgrade** to the Phase 32 ticket engine
(`docs/support-tickets-phase32.md`). It keeps the same `SupportTicket` /
`SupportMessage` models, the same status transitions, the same owner/admin
scoping and the same notifications, and layers on three things:

1. **Structured classification** — every new ticket carries a machine
   **category** and an **origin** (where it was opened from).
2. **Service linking** — a ticket can reference the exact owner-scoped
   `Service` it is about (from the wizard, a Service page, the connection
   guide, or self-diagnostics).
3. **Secure Telegram attachments** — a message can carry **one** photo or
   document, stored only as a Telegram **file reference** (never bytes, never
   a download, never a parsed/inspected file).

Nothing here touches Order / Payment / CheckoutSession / Wallet / Product /
Panel / Service lifecycle. Attachments are **off by default** — text-only
support is unchanged until the OWNER enables them.

## Source map

| Concern | File |
| --- | --- |
| Typed contract (codes, allowlists, validation, size buckets, setting keys) | `packages/shared/src/support-tickets-v2.ts` |
| Ticket service (create/reply/close/resolve, idempotency, notifications) | `apps/bot/src/services/support-ticket.service.ts` |
| Attachment settings (master switch + byte ceiling) | `apps/bot/src/services/support-attachment-settings.service.ts` |
| Privacy-safe attachment event logging + counters | `apps/bot/src/services/support-attachment-log.service.ts` |
| Unified input extractor (`extractSupportMessageInput`) | `apps/bot/src/handlers/user-support/support-input.ts` |
| Detail rendering helpers (message line, attachment button, re-send) | `apps/bot/src/handlers/user-support/support-detail.ts` |
| User flow (wizard, direct entry, replies, retrieval) | `apps/bot/src/handlers/user-support/support.handler.ts` |
| Admin flow (detail, replies, retrieval) | `apps/bot/src/handlers/admin-support/support-admin.handler.ts` |
| OWNER attachment settings page | `apps/bot/src/handlers/admin-settings/support-attachments-admin.handler.ts` |

## Schema — migration `20260722100000_support_tickets_v2_categories_attachments`

Purely additive, all columns nullable, no destructive change:

- `SupportTicket.category` `String?`, `SupportTicket.origin` `String?`, index
  `[category, updatedAt]`.
- `SupportMessage`: `attachmentType` / `fileUniqueId` / `fileName` /
  `mimeType` `String?`, `fileSizeBytes` `BigInt?`, `sourceMessageId` `Int?`,
  and `sourceUpdateId` `BigInt?` **@unique**; index `[ticketId, createdAt]`.

The `SupportMessage.fileId` column already existed (Phase 32, unused) and is
now the stored Telegram photo/document reference. No binary content, no
download URL, no external storage, no base64 anywhere.

## Typed vocabulary (behaviour is code-driven, never label-driven)

- **Categories**: `CONNECTION`, `PAYMENT`, `SERVICE_MANAGEMENT`, `ACCOUNT`,
  `OTHER`. Callback codes `c/p/s/a/o` (`user:sup:cat:<code>`). `CONNECTION` and
  `SERVICE_MANAGEMENT` prompt for a Service up front; the others may still
  *opt in* to link one via «اتصال تیکت به یک سرویس».
- **Origins**: `GENERAL`, `SERVICE_DETAIL`, `CONNECTION_GUIDE`,
  `SERVICE_DIAGNOSTICS` — audit/admin visibility only.
- **Attachment types**: `PHOTO`, `DOCUMENT`.

Persian labels (`SUPPORT_CATEGORY_LABEL_FA` / `SUPPORT_ORIGIN_LABEL_FA`) are
**display only** and are *not* editable text templates, so an operator can
never repurpose a label to change routing. The editable ButtonText labels for
the category keyboard (`support_category_*`) drive nothing — the code does.

## Attachment security contract (`validateSupportAttachment`)

- **PHOTO** — trusted as an image by Telegram; only the byte ceiling is
  enforced (when a size is reported).
- **DOCUMENT** — must have a **non-zero, in-limit** reported size and an
  **allowlisted** extension AND/OR MIME that, when both are present, are
  **compatible**:
  - MIME allowlist: `application/pdf`, `text/plain`, `application/json`,
    `image/png`, `image/jpeg`, `image/webp`.
  - Extension allowlist: `.pdf`, `.txt`, `.log`, `.json`, `.png`, `.jpg`,
    `.jpeg`, `.webp`.
- Everything else — executables, scripts, HTML, **SVG**, archives, macros,
  zero-byte, over-limit, or an extension/MIME **mismatch** — is a typed
  rejection.
- File names are **untrusted hints**: `sanitizeSupportFileName` strips any
  path, drops control/reserved/HTML characters, collapses whitespace and
  bounds the name to 120 chars. The bot **never** downloads, opens, unzips,
  parses or executes a file; admins see an explicit "untrusted file" notice.

Typed rejection reasons (`SUPPORT_ATTACHMENT_REJECTIONS`): `DISABLED`,
`ALBUM`, `EMPTY`, `TOO_LARGE`, `TYPE_REJECTED`, `ZERO_BYTE`,
`METADATA_INVALID`, `CAPTION_TOO_LONG`. Each maps to a safe Persian template;
none ever echoes user content.

### One attachment per message

A media group (`media_group_id`) is rejected wholesale
(«لطفاً فایل‌ها را جداگانه ارسال کنید.») so a single album item never
half-creates a ticket. A valid message needs **non-empty text OR one valid
attachment**; text is 1..3000, an optional caption is 0..1000.

## Unified input handler

`extractSupportMessageInput(message, settings)` is pure and synchronous — it
turns one inbound Telegram message into a typed `text` / `attachment` /
`command` / `unsupported` / `rejected` result. It **never** logs text,
captions, file ids or file names, **never** downloads, cancels the flow on any
`/command`, rejects albums, enforces the master switch + type + size, and
picks the **largest** photo size. `supportInputHandler` (a `.on("message")`
composer) dispatches subject / message / reply steps; it is wired **before**
the text-only bail in `app.ts` so photos and documents actually reach it.

## Idempotency (`sourceUpdateId`)

Each ticket/message write keys on the inbound `ctx.update.update_id`
(nullable, **unique** `sourceUpdateId`). The first-message / reply insert is
the **last** statement in its transaction, so a duplicate Telegram delivery
rolls back the whole transaction (including the status flip); the caller
catches the unique violation and returns the already-created ticket with
`created: false` — so exactly one ticket, one message, one notification.
A synchronous **claim-before-await** of the session (flow + draft + diagnostic
context) additionally prevents a concurrent double-submit from the same
session. Idempotency never keys on text, captions or file ids.

## Attachment retrieval

`user:sup:att:<ticketSid>:<messageSid>` (and `admin:sup:att:…`, each ≤64
bytes) re-validate the short ids, resolve the ticket **owner/admin-scoped**,
confirm the message belongs to that ticket and carries an attachment, then
re-send it by its **stored fileId** (`sendPhoto`/`sendDocument`) with
`protect_content: true` and a **generic** caption (no fileId, no Service
secret). An expired file reference yields
«این ضمیمه دیگر از طریق تلگرام قابل دریافت نیست.» — no admin-supplied
arbitrary file id is ever sent.

## Linked-Service surfaces

- **User** sees the public label + status + «مشاهده سرویس».
- **Admin** additionally sees quota / expiry / last-sync — never secrets.
- A null relation renders «سرویس مرتبط دیگر در دسترس نیست.» and never blocks
  replies.

The linked Service is always **re-resolved owner-scoped at final submission**,
so a stale session can never attach another user's Service. The diagnostics
handoff additionally re-validates its strict snapshot; attachment metadata
never enters that snapshot.

## Notifications

Admin/user notifications stay **text-only** and now include the stable
**category** label, the **linked Service** public label and a
«📎 دارای ضمیمه» indicator when the triggering message carries an attachment.
They never include a fileId, caption or secret, fire **once**, and are
fault-isolated (a send failure never rolls back the ticket mutation).

## OWNER settings — «تنظیمات ضمیمه‌ها 📎»

Reached from تنظیمات عمومی. OWNER-only (the handler re-checks on every
action). Shows the enabled state, the current per-file ceiling, the allowed
formats, a 24-hour accepted/rejected counter and the safety warning. Actions:
enable/disable (atomic CAS), size presets **5/10/15/20 MiB**, reset-to-default,
and a **synthetic preview** (fabricated sample lines — no real ticket, file or
panel is read or written).

- Master switch: `support_attachments_enabled` (default `false`).
- Byte ceiling: `support_attachment_max_bytes` (default 15 MiB, min 1 MiB,
  max 20 MiB — code-owned + clamped, so tuning needs no migration).

Disabling only stops **new** attachment input; it deletes no metadata and
leaves text-only support unchanged.

## Privacy & logging

Attachment events (`support.attachment_accepted` /
`support.attachment_rejected`) record **only**: operation, sender type,
attachment type, a coarse **size bucket** (never the exact byte count),
category/origin codes, the typed rejection code, and a non-reversible
correlation hash. They **never** record message text, caption, subject,
fileId, fileUniqueId, the full filename, the Telegram-reported MIME, the
Telegram user/chat id, the Service id, username, URL, config or token.

## Explicitly out of scope

Voice / video / stickers / animations, media albums, file downloads,
antivirus / content inspection, external object storage, base64 payloads,
ticket departments and SLA timers. See the spec's non-goals — this feature is
metadata + Telegram references only.

## Tests

- `apps/bot/tests/support-attachments-contract.test.ts` — pure contract:
  validation allow/deny matrix, filename sanitisation, size buckets, the input
  extractor, and detail rendering (no DB).
- `apps/bot/tests/support-tickets-v2.test.ts` — DB: attachment persistence,
  category/origin/linked-Service, `sourceUpdateId` idempotency, owner/admin
  retrieval scoping, notification content, privacy-safe counters.
- `apps/bot/tests/support-attachments-admin.test.ts` — OWNER settings page:
  guard, toggle, presets, reset, synthetic preview.
- `apps/bot/tests/support-tickets.test.ts` and
  `apps/bot/tests/service-diagnostics-flow.test.ts` — updated to the V2
  service signatures and the unified input handler.
