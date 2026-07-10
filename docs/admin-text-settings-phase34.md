# ZED_BOT admin text settings (Phase 34)

Phase 34 gives admins in-bot editing of the operator-editable texts that
`text.service.ts` already reads: `MessageTemplate` rows (start/support/…
copy) and `ButtonText` rows (user-menu button labels). Rows are edited or
reset to their defaults, never deleted; the text cache is cleared after
every change so edits apply immediately. No migration (models existed) —
only a seed addition (`my_orders`, the Phase 29 button key that previously
lived as a code fallback only). No payment/order/service/support/broadcast
logic changed.

Source: `apps/bot/src/services/admin-text-settings.service.ts`, UI in
`apps/bot/src/handlers/admin-settings/text-settings.handler.ts`.

## Admin path

پنل مدیریت 🛠 → «تنظیمات عمومی ⚙️» (`admin:general_settings` — the existing
button/callback; the placeholder page was replaced by a real landing) →
**«مدیریت متن‌ها ✍️»** (`admin:texts`) → «پیام‌ها / قالب‌ها 📝»
(`admin:texts:templates:<page>`) or «متن دکمه‌ها 🔘»
(`admin:texts:buttons:<page>`). Details: `admin:texts:t:<sid>` /
`admin:texts:b:<sid>`; edit `admin:texts:edit_t|edit_b:<sid>` (flows
`admin_texts:template` / `admin_texts:button`); reset
`admin:texts:reset_t|reset_b:<sid>` → confirmation →
`admin:texts:reset_yes_t|reset_yes_b:<sid>`. All under 64 bytes, all
admin-only, and `showAdminMenu` clears the edit state like every other
wizard.

## MessageTemplate behavior

List: 10/page sorted by key, rows `📝|🔒 key | title`. Detail: key, title,
category, editable flag, `allowedVariables` (displayed as text only — never
evaluated), the current content (600-char escaped preview) and the default
content (300-char escaped preview). Editable rows get «ویرایش ✏️» (new
multiline text, trimmed, 1..4000 chars) and «بازنشانی به پیش‌فرض ♻️»
(confirmed; `currentContent = defaultContent`). Updates/resets are
`updateMany` guarded on `isEditable: true` — a non-editable row refuses
with «این متن قابل ویرایش نیست. 🔒» even if a stale button is pressed —
and stamp `updatedByAdminId`.

## ButtonText behavior

Same shape: rows `🔘|🔒 key | currentText`, detail with current/default
text, edit (trimmed, 1..64 chars — Telegram button labels are short) and
confirmed reset, `isEditable`-guarded, `updatedByAdminId` stamped. The
existing `getButtonText` fallbacks in `text.service.ts` are untouched, so
missing rows still degrade safely.

## Cache clearing

`text.service.ts` caches templates and button texts for 30s. Every
successful update/reset calls `clearTextCache()`, so the very next read
returns the new value (test-verified end-to-end through `getButtonText` /
`getMessageTemplate`). Note the cache is per-process; in a multi-process
deployment other processes converge within the 30s TTL.

## Safety / HTML notes (documented limitation)

Texts are stored **exactly as the admin sent them** — Phase 34 does no
HTML/markdown validation. Detail previews are always HTML-escaped, so
whatever is stored renders harmlessly in the admin UI. Wherever a template
is later rendered with an HTML parse mode, the existing rendering code
remains responsible for escaping its variables. Variables are never
evaluated by this phase; `allowedVariables` is informational display only.
Only 8-char short ids appear (take-2 lookup rule); rows are never deleted.

## Seed / baseline

The seed already contained the important template keys (`start_text`,
`bot_off_text`, `support_text`, `faq_text` — wallet-topup instruction and
payment-page notice live in the `Setting` model per Phase 22 and were NOT
duplicated) and all main-menu button keys except `my_orders`, which was
added. Seeding stays create-if-missing — operator edits are never
clobbered.

## Testing

`apps/bot/tests/admin-text-settings.test.ts`: pagination over both lists;
short-id resolution with gibberish rejection; template update changing
`currentContent` + `updatedByAdminId` and reset restoring
`defaultContent`; the same pair for buttons; non-editable rows refusing
both update and reset with content untouched; length-bound validation for
both kinds; and the cache round-trip (cached `getButtonText`/
`getMessageTemplate` values change immediately after a service update).

## Intentionally NOT implemented

Web panel, mini app, rich template editor, HTML/markdown validation,
variable evaluation/previews, per-language UI (locale column untouched),
version history UI, import/export, row creation/deletion, Phase 35+.
