# Text system architecture

How ZED_BOT stores, renders and safeguards every operator-facing and
user-facing string. Locked by `apps/bot/tests/persian-text-alignment.test.ts`;
the approved copy itself is mapped in `docs/persian-text-alignment.md`.

## The four storage layers

| Layer | Storage | Editable | Used for |
| --- | --- | --- | --- |
| **MessageTemplate** | DB row (`key`, `defaultContent`, `currentContent`, `allowedVariables`, `isEditable`) | operators, per row | page/message bodies: start text, gates, prompts, empty states |
| **ButtonText** | DB row (`key`, `defaultText`, `currentText`, `isEditable`) | operators, per row | inline-keyboard labels (main menu, navigation, support, history) |
| **Setting** | DB row (typed key/value) | operators/admin flows | operational values: bot name, maintenance mode, support mode, limits |
| **Typed Persian constants** | exported `const` in code | code review only | one-off context texts tied to logic: outcome toasts, validation errors, invoice/card layouts |

Rule of thumb: if a text is pure copy an operator may want to reword, it is a
MessageTemplate/ButtonText. If its wording is welded to control flow or typed
data (amounts, statuses, masked card numbers), it is a typed constant so a
text edit can never change behavior or leak unescaped values.

## The seed registry is the single source of defaults

`packages/database/src/seed-data.ts` exports `INITIAL_MESSAGE_TEMPLATES` and
`INITIAL_BUTTON_TEXTS` — every operator-editable text's stable `key`, admin
`title`, Persian default and (for templates) the explicit allowed-variable
list. Generated reference tables: `docs/message-template-registry.md` and
`docs/button-text-registry.md`.

The bot's in-code fallbacks are **derived from this registry**
(`apps/bot/src/services/text.service.ts` builds its fallback maps from the
seed arrays), so default copy exists in exactly one place. Resolution order in
`getMessageTemplate` / `getButtonText`:

1. DB row `currentContent` / `currentText` (when the DB is reachable);
2. explicit per-call fallback, if the caller passed one;
3. registry default for the key;
4. the bare key itself (last resort — the bot never crashes over a text).

Reads are cached for **30 seconds** per key. `clearTextCache()` drops the
cache; the admin text editor calls it on every successful update/reset so
edits are visible immediately.

## Seed default-refresh semantics

The seed (`packages/database/src/seed.ts`) is idempotent:

- missing rows are created with `current = default`;
- when a registry default changes, the stored **default** (and allowed
  variables/title/category) is refreshed so «بازنشانی به پیش‌فرض» returns the
  approved copy;
- the **current** value moves along only when the operator never customized
  it (`existing.currentContent === existing.defaultContent`); an
  operator-edited text is **never overwritten** by a deploy.

Reset-to-default is per item in the admin editor (never a bulk reset).

## Operator editing

Operators edit texts from «تنظیمات عمومی ⚙️ → مدیریت متن‌ها ✍️»
(`admin-text-settings.service.ts` + `text-settings.handler.ts`):

- only `isEditable` rows can be updated or reset; rows are never deleted;
- template content is bounded to 1..4000 characters, button labels to 1..64
  (Telegram's label budget); content is stored exactly as sent;
- every successful mutation stamps `updatedByAdminId` and clears the cache;
- rendered previews are HTML-escaped at render time, and views that send
  template content with `parseMode: HTML` escape it (`escapeHtml`), so a bad
  edit can never make Telegram reject a page.

## Variable registry and edit-time validation

Each template row carries its explicit `allowedVariables` list (empty = takes
no variables). `apps/bot/src/services/template-variables.ts` gates every
admin edit:

- `{placeholders}` outside the row's allowed list (plus any already present
  in the row's default, for legacy rows) are rejected with
  «متغیر استفاده‌شده در این قالب معتبر نیست.»;
- **secret-shaped names are rejected even if allowed** — anything matching
  `token|password|passwd|cookie|secret|credential|database_url|db_url|file_id|stock_content|api_key`
  can never become renderable through a template.

Validation is the edit-time gate; rendering stays graceful.

## Rendering

`apps/bot/src/utils/template.ts`:

- `renderTemplate(text, vars)` substitutes `{name}` placeholders; unknown
  placeholders render **verbatim** (operator-owned literal braces never break
  a message);
- `renderTemplateOmitMissing(text, vars)` additionally treats
  `undefined`/`null`/`""` values as *missing* and removes every **line** that
  references them (e.g. a user without a Telegram username never sees a
  dangling «نام کاربری:» label), then collapses leftover blank runs. Used by
  templates with optional variables such as `start_text`.

## Labels never carry behavior

Callback data **never derives from label text**. Routes are stable constants
(`apps/bot/src/core/callbacks.ts` and per-handler `*_CB` maps, all ≤64
bytes); ButtonText edits change only what the user sees. Editing
`buy_subscription` relabels the button while it keeps emitting `user:buy` —
so operators cannot break navigation, and old keyboards in Telegram chats
keep working. Whole-tree route integrity (no dead buttons, no orphan routes)
is locked by `apps/bot/tests/navigation-integrity.test.ts`.

## Main-menu labels and reply-keyboard routing

Since the menu-keyboard-mode phase, the 8 user main-menu ButtonText rows
(`MAIN_MENU_BUTTON_KEYS`) do double duty: besides being displayed, their
**current** labels are what incoming reply-keyboard text is matched
against when the user menu runs in `REPLY` mode (exact trimmed match →
language-neutral action; the label still never selects behavior on its
own — the wiring is stable). Consequences:

- label edits apply immediately in **both** keyboard modes (the cache is
  cleared on every edit), and the old label stops routing at the same
  moment;
- `updateButtonText` rejects an edit that would make two main-menu labels
  identical — «این متن دکمه با یکی دیگر از دکمه‌های منوی اصلی یکسان است.»
  — since a duplicate would make text routing ambiguous (the resolver
  additionally fails safe to no action on any residual ambiguity). The
  guard is scoped to the 8 main-menu keys only.

Design details in `docs/user-menu-keyboard-modes.md`.
