# ZED_BOT panel management (Phase 4)

Phase 4 replaces the `admin:panels` placeholder with a real admin flow for
managing VPN panels (Marzban and XUI/Sanaei/3X-UI): add, list, view, edit,
toggle features/prices/settings, soft-delete, and a connection test. It also
adds reusable AES-256-GCM secret encryption. **No products, purchases,
payments, or service provisioning** — only panel configuration.

Source: `apps/bot/src/handlers/panels/`, `apps/bot/src/services/panel*.ts`,
`packages/shared/src/crypto.ts`, `packages/panel-adapters/`.

## Admin callbacks

| Callback | Action |
| --- | --- |
| `admin:panels` | Panel management menu (Add / List / Back) |
| `admin:panels:add` | Choose panel type (Marzban / XUI) |
| `admin:panels:add:MARZBAN` \| `:XUI` | Start the add wizard |
| `admin:panels:cancel` | Cancel the current flow |
| `admin:panels:list[:page]` | Paginated panel list (8/page) |
| `admin:panel:view:<sid>` | Panel detail |
| `admin:panel:test:<sid>` | Test connection |
| `admin:panel:st:<sid>[:STATUS]` | Status menu / set status |
| `admin:panel:vis:<sid>` | Toggle visibility |
| `admin:panel:feat:<sid>` | Feature toggles page |
| `admin:panel:tg:<sid>:<key>` | Flip one toggle |
| `admin:panel:price:<sid>` | Pricing page |
| `admin:panel:ts:<sid>` | Test-settings page |
| `admin:panel:us:<sid>` | Username-settings page |
| `admin:panel:up:<sid>:<i>` | Open/select username pattern |
| `admin:panel:cfg:<sid>` | Marzban/XUI settings page |
| `admin:panel:fe:<sid>:<key>` | Start editing a field (text input) |
| `admin:panel:del:<sid>[:yes]` | Soft-delete confirm/execute |

`<sid>` is the panel UUID's first 8 chars. Full UUIDs would blow past
Telegram's 64-byte callback limit, so panels are resolved by unique id prefix
(`getPanelByShortId`); an ambiguous prefix resolves to nothing rather than
guessing. Field/toggle keys are short codes (`pgb`, `sp`, ...) mapped in
`panel-fields.ts`.

## Add panel flow

Session-driven (`session.currentFlow = "panel:add"`, state in
`session.temp.panelAdd`):

1. Choose type → 2. name → 3. base URL (validated/normalized) →
4. Marzban: username + password / XUI: token → save with schema defaults
(`status ACTIVE`, `isVisible true`, next `displayOrder`,
`renewalMethod RESET_VOLUME_AND_TIME`) → success message + type-specific
"complete these settings later" warning + panel detail.

Base URL rules (`utils/url.ts`): must start with `http://`/`https://`;
trailing slashes stripped; `/dashboard` rejected; `:443` removed, other ports
kept; domains and IPs allowed.

## List / detail / edit

- **List**: paginated buttons `🟢 name | TYPE` (+ `🙈` when hidden), status
  emoji ACTIVE 🟢 / INACTIVE ⚪️ / MAINTENANCE 🟡 / FAILED 🔴.
- **Detail**: name, type, URL, status, visibility, groups, renewal method,
  capacity, created/active counts, sub domain, username pattern, key toggles,
  prices, last update — **never credentials**. Buttons for test, edit
  name/URL/credential, status, visibility, features, prices, test settings,
  username settings, panel settings, delete.
- **Edit fields**: a single registry (`panel-fields.ts`) drives every edit —
  `text`, `int` (≥0), `json-int-array` (`1,2,3` or `[1,2,3]`), and
  `json-object` (validated JSON) kinds, with nullable fields cleared by
  sending `-`. One `message:text` handler consumes input only when an admin
  is in a `panel:*` flow.
- **Feature toggles**: 21 boolean flags flip in place via
  `admin:panel:tg:<sid>:<key>` and re-render.
- **Delete**: no physical delete (history is preserved for future
  services/orders). Confirmation → `status INACTIVE` + `isVisible false` →
  «پنل غیرفعال و مخفی شد.»

## Encryption

`@zedbot/shared`: `encryptSecret` / `decryptSecret` / `maskSecretEdges`.

- AES-256-GCM (authenticated); key = `scrypt(APP_SECRET, ...)`.
- Format `v1:<iv>:<authTag>:<ciphertext>` (base64) — versioned for rotation.
- Random IV per call; tampering and wrong-key both throw (never silently
  return garbage).
- Missing `APP_SECRET` throws `SecretConfigError` — no weak fallback. The bot
  still starts; only add/edit-credential operations fail, with a clear
  Persian message.
- Credentials are decrypted only inside the test-connection service, never
  logged, never returned. Detail view never shows them; credential edits
  acknowledge with masked edges only.

## Adapters / testConnection

`packages/panel-adapters`: `PanelAdapter.testConnection(): Promise<PanelHealthResult>`
(`{ ok, message, details? }`), 10s timeout, errors sanitized (no
headers/bodies).

- **Marzban** — real: `POST /api/admin/token` with the decrypted
  username/password; 200 + `access_token` → ok, 401 → wrong credentials,
  other → HTTP status, network failure → unreachable. Verified against a mock
  server.
- **XUI** — honest placeholder: probes URL reachability but returns
  `ok: false` with "authenticated XUI test is not implemented in this phase".
  **Never fakes success.**

## Intentionally NOT implemented

Products, purchases, checkout, payments, orders, service provisioning,
Marzban/XUI create-user (and all other write) APIs, XUI authenticated test,
role-based admin restrictions (any active admin manages panels), username
generation, and use of the stored test/username/protocol settings. Other
admin sections (finance, receipts, users, products, ...) remain placeholders.

## Safety rules

- Credentials encrypted at rest; never logged, never shown in full.
- Panels are soft-deleted, preserving history.
- Base URLs validated/normalized before saving.
- Flow state is cleared on save/cancel and when a command interrupts a flow,
  so `/start` and `/menu` always work.
- The text-input handler only consumes messages from active admins in a
  `panel:*` flow; normal user text is untouched.
