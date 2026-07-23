# Admin main-menu keyboard mode

The admin main menu («پنل مدیریت 🛠») renders in one of two keyboard
modes, selected by its **own** global, admin-configurable setting —
independent of the user main menu's setting
(`docs/user-menu-keyboard-modes.md`): **inline** — glass buttons inside
the menu message (the historical behavior and the default) — or
**reply** — a persistent Telegram reply keyboard below the input field.
Only the keyboard *type* switches. The approved admin menu structure,
labels, ordering and visibility rules are one shared definition consumed
by both renderers, so the two modes can never drift apart.

Code map:

| Concern | File |
| --- | --- |
| Both settings (`user_main_menu_keyboard_mode`, `admin_main_menu_keyboard_mode`) | `apps/bot/src/services/menu-mode.service.ts` |
| Shared admin menu definition, reply renderer, text resolver | `apps/bot/src/keyboards/admin-menu-definition.ts` |
| Inline renderer (same definition) | `apps/bot/src/keyboards/admin-main.keyboard.ts` |
| Shared action dispatcher + admin reply text router | `apps/bot/src/handlers/admin-menu-actions.ts` |
| Admin menu render branch + transitions (`showAdminMenu`) | `apps/bot/src/handlers/admin.handler.ts` |
| User-side transitions (`showUserMenu`) | `apps/bot/src/handlers/menu.handler.ts` |
| Combined settings page «نوع نمایش منوها» | `apps/bot/src/handlers/admin-settings/text-settings.handler.ts` |
| Per-menu duplicate-label guard on button edits | `apps/bot/src/services/admin-text-settings.service.ts` |
| `admin_*` ButtonText seeds | `packages/database/src/seed-data.ts` |
| Unseeded-install label fallbacks | `apps/bot/src/services/text.service.ts` |
| Router registration order | `apps/bot/src/app.ts` |
| Session flags for the on-screen persistent keyboard | `apps/bot/src/core/session.ts` |

## Two independent settings — four combinations

`apps/bot/src/services/menu-mode.service.ts` now holds two Settings, one
per menu, with the same value set (`MenuMode = "INLINE" | "REPLY"`) and
the same Persian display labels (`MENU_MODE_LABELS`: `INLINE` →
«دکمه شیشه‌ای داخل پیام», `REPLY` → «دکمه معمولی پایین صفحه»):

| Setting key | Constant | Reader / writer |
| --- | --- | --- |
| `user_main_menu_keyboard_mode` | `USER_MENU_MODE_KEY` | `getUserMenuMode` / `setUserMenuMode` |
| `admin_main_menu_keyboard_mode` | `ADMIN_MENU_MODE_KEY` | `getAdminMenuMode` / `setAdminMenuMode` |

Both are global `STRING` Settings (no per-user / per-admin preference)
and both parse **fail-closed**: an absent row *and any unknown/garbage
value* resolve to `INLINE`. Existing installations keep their exact
current behavior with no migration, and production admin menus never
switch to a reply keyboard without an explicit operator choice.

The settings are fully independent — each menu render consults only its
own setting — so all four combinations are supported:

| User menu | Admin menu | Result |
| --- | --- | --- |
| `INLINE` | `INLINE` | historical behavior everywhere (the default) |
| `REPLY` | `INLINE` | users get the persistent keyboard; admins keep inline |
| `INLINE` | `REPLY` | admins get the persistent keyboard; users keep inline |
| `REPLY` | `REPLY` | both persistent — only one keyboard is on screen at a time (see transitions) |

The only cross-coupling between the two scopes is physical and
deliberate: a chat can show only one persistent keyboard at a time (the
user and admin menus replace each other's, see below), and a label shared
by both menus falls through from the admin router to the user router for
non-admins (see routing).

## One admin menu definition, two renderers

`buildAdminMainMenuDefinition()` in
`apps/bot/src/keyboards/admin-menu-definition.ts` is the single source of
the admin main menu: the approved row layout, ten **language-neutral
action identities** (`AdminMainMenuAction`), operator-editable labels and
the shared visibility policy. Action identity never derives from the
visible Persian label — the stable wiring is
`ADMIN_MAIN_MENU_ACTION_WIRING` (action → ButtonText key + inline
callback):

| Action | ButtonText key | Inline callback |
| --- | --- | --- |
| `FINANCE` | `admin_finance` | `admin:finance` |
| `USERS` | `admin_users` | `admin:users` |
| `PRODUCTS` | `admin_products` | `admin:products` |
| `PANELS` | `admin_panels` | `admin:panels` |
| `OTHER_PRODUCTS` | `admin_other_products` | `admin:other_products` |
| `SUPPORT_TICKETS` | `admin_support_tickets` | `admin:support` |
| `BROADCAST` | `admin_broadcast` | `admin:broadcast` |
| `GENERAL_SETTINGS` | `admin_general_settings` | `admin:general_settings` |
| `REPORTS_BACKUP` | `admin_reports_backup` | `admin:reports_backup` |
| `RETURN_TO_USER_MENU` | `admin_return_user_menu` | `user:menu` (the **existing** `CB.USER_MENU`) |

The approved layout is the historical inline layout plus one appended row:
five historical rows — finance+users · products+panels · other-products ·
support+broadcast · general-settings+reports-backup — then a final
**full-width** two-way-navigation row `RETURN_TO_USER_MENU`
(«بازگشت به منوی کاربر 👤»). The historical rows are unchanged; the return
row is always last and never sits beside a sensitive section.

**Two-way navigation.** `RETURN_TO_USER_MENU` is the only action that is not
an admin *section* — it exits to the user surface. Its inline callback is the
existing `CB.USER_MENU` (no new callback is minted), so an inline tap flows
through the normal user area
(`userAccessMiddleware → menuHandler → showUserMenu`) exactly like `/menu`. In
REPLY mode the label resolves to the `RETURN_TO_USER_MENU` action and
`admin-menu-actions.ts` handles it directly: `ensureUserAccess(ctx)` then the
shared `showUserMenu(ctx)`. Either way the user-access gates
(maintenance / blocked / terms / force-join) apply first — an active admin
**never** bypasses the user gates via the return button, because admin access
and user access are independent. `showUserMenu` owns every keyboard transition
and session flag, so no rendering or state handling is duplicated. Sensitive
admin submenus keep their own «بازگشت به پنل ادمین» back button and do **not**
each gain a direct user-menu exit; the admin main menu is the single place to
return to the user surface.

**Visibility policy** (`visibleActions`, shared by both renderers *and*
the text resolver): the approved admin main menu is currently identical
for every **active** admin — role gates live inside the sections
themselves (e.g. the OWNER-only reconciliation, backup and
trial-settings pages). A `null` or inactive admin sees **no** admin menu
at all (empty definition). This hook is where per-role hiding lands when
centralized RBAC ships (a documented separate task).

The definition is **built fresh per render** — operator label edits
apply immediately in *both* modes — and the two renderers consume it
verbatim:

- **Inline** (`buildAdminMainKeyboard`,
  `apps/bot/src/keyboards/admin-main.keyboard.ts`): each button gets its
  current label and its stable callback. The historical hardcoded labels
  are now the seeded ButtonText **defaults**, so existing installations
  render byte-identically; the callback contract is unchanged.
- **Reply** (`buildAdminMainReplyKeyboard`,
  `admin-menu-definition.ts`): identical rows and labels, **no callback
  data anywhere** (reply buttons send their text). The keyboard is
  `.resized()`, `.persistent()` and sets the input placeholder
  «یک گزینه را انتخاب کنید». It is always built per admin/request —
  never cached as one global keyboard.

## Reply text routing and authorization

Reply-keyboard buttons arrive as ordinary text messages, so the admin
REPLY mode needs a text → action resolver and a router — both
deliberately narrow, and neither ever authorizes by text.

### Exact current-label matching (`resolveAdminMainMenuAction`)

- The incoming text is trimmed; empty strings and anything starting with
  `/` never resolve.
- It is compared for **exact equality** (after trimming) against the
  *current* labels of the admin menu — no substring, prefix or fuzzy
  matching; edited labels keep routing immediately and old labels stop
  at the same moment.
- Matching runs over the **full approved menu, visibility-independent**,
  so a deactivated admin's stale keyboard is *recognized — and denied* —
  instead of falling through as arbitrary text.
- **Ambiguity fails safe**: anything other than exactly one label match
  resolves to `{ matched: false }`.
- The result is a three-state resolution: `{ matched: false }` ·
  `{ matched: true, authorized: false }` ·
  `{ matched: true, authorized: true, action }`. **Matching alone never
  authorizes**: the sender must be an active admin *and* the matched
  action must be visible to them, or the result is unauthorized for the
  caller to deny.

### The admin text router (`adminMenuTextRouter`)

Registered in `app.ts` **after** the flow-gated message dispatcher and
**immediately before** the user menu text router, giving the approved
priority:

> command → active conversation flow → admin reply action → user reply
> action → fallback

Inside the router the checks run in this order, and everything that does
not fully match falls through untouched:

1. an active flow (`ctx.session.currentFlow !== null`) → pass through
   (defense in depth on top of the registration order);
2. text starting with `/` → pass through (**commands always win**);
3. the **admin** menu mode is not `REPLY` → pass through (in INLINE mode
   the router is completely inert — typed admin labels are just text);
4. no exact label match → pass through (**arbitrary text is never
   navigation**);
5. matched but **unauthorized** (non-admin, or a deactivated admin still
   carrying the old persistent keyboard): if the user menu mode is
   `REPLY` *and* the same text is also a live **user** main-menu label
   (`resolveMainMenuAction`), the message passes through to the user
   router — the two menus are separate routing contexts, so a shared
   label keeps working for non-admins in their own context. Otherwise
   the router answers only the safe denial
   (`ADMIN_MENU_ACCESS_DENIED_TEXT`):

   > شما دسترسی لازم برای ورود به این بخش را ندارید.

6. authorized → the section opens via `openAdminMainMenuSection`.

### One dispatcher, the same section entries

`openAdminMainMenuSection` (`apps/bot/src/handlers/admin-menu-actions.ts`)
maps each action to the **exact section landing function the inline
callback already uses** — `renderFinanceLanding`,
`renderAdminUsersLanding`, `showProductMenu`, `renderPanelMenu`,
`renderManualOrdersLanding` (other products), `renderAdminSupportLanding`,
`renderBroadcastLanding` (broadcast), `renderSettingsLanding` (general
settings), `renderReportsBackupLanding`. No callback queries are
synthesized, no business logic is duplicated and **no mutation happens
here**: every reachable action is a safe top-level navigation render,
with every deeper role gate (OWNER-only reconciliation/backup/trial
pages, …) living inside those sections exactly as before.

Sensitive and destructive admin operations are **Inline-only by
construction**: the reply keyboard carries only the 9 top-level
navigation labels (no entity ids, no mutations), and the resolver knows
only those 9 labels — approvals, deletions, broadcast sends, backups and
every other consequential step stay behind stable inline callbacks plus
their existing confirmation steps, unreachable from text.

## Mode transitions — replacement and removal

Two session flags (`apps/bot/src/core/session.ts`) together track
*which* persistent keyboard is currently on screen:
`replyMenuKeyboardActive` (user menu) and
`adminReplyMenuKeyboardActive` (admin menu).

`showAdminMenu` (`apps/bot/src/handlers/admin.handler.ts`, behind admin
auth, entered via `/admin` and `admin:menu`) branches on the **admin**
mode at render time:

- **REPLY**: the menu («پنل مدیریت 🛠\n\nیک بخش را انتخاب کنید:») is
  always a **fresh message** carrying the persistent keyboard — Telegram
  cannot attach reply keyboards via `editMessageText`. Sending it
  **replaces** whatever persistent keyboard (user or admin) is on screen,
  with no removal message; the session flags flip to
  `adminReplyMenuKeyboardActive = true`, `replyMenuKeyboardActive = false`.
- **INLINE** while *either* flag is still set (a stale user **or** admin
  persistent keyboard is up): the bot first sends the one-time transition
  notice

  > نوع منوی ربات تغییر کرده است.

  with `remove_keyboard: true`, clears both flags, then renders the
  inline menu as usual (edit-in-place for callbacks, fresh reply for
  commands). The notice appears **exactly once** per transition.

`showUserMenu` (`apps/bot/src/handlers/menu.handler.ts`) mirrors this on
the user side: its REPLY branch replaces the on-screen keyboard —
**including the admin one** — and flips the flags the other way
(`replyMenuKeyboardActive = true`, `adminReplyMenuKeyboardActive = false`);
its INLINE branch removes a stale persistent keyboard of *either* menu
exactly once with the same notice.

Nothing is broadcast when an operator flips either setting; transitions
are lazy and quiet, per chat, on the next menu render. In the interim
window, taps on a stale admin reply keyboard send plain text that the
admin router ignores (the admin mode is not REPLY), and old inline admin
menu messages keep working because the inline callbacks are stable and
stay registered.

## Settings page: تنظیمات عمومی ⚙️ → نوع نمایش منوها

One combined page (`apps/bot/src/handlers/admin-settings/text-settings.handler.ts`)
manages **both** independent settings. Every step of this surface stays
**fully Inline regardless of the modes being configured**; every route
requires an authenticated admin (`ctx.admin`); scope and mode always come
from the stable callback data, never from visible labels; and a mode
change always goes through an explicit confirmation step.

1. **Overview** — the general-settings landing (`admin:general_settings`)
   carries the «نوع نمایش منوها» button → `admin:menu_mode`, which shows
   the current mode of both menus:

   > نوع نمایش منوها
   >
   > منوی کاربر:
   > دکمه شیشه‌ای داخل پیام
   >
   > منوی ادمین:
   > دکمه شیشه‌ای داخل پیام

   Buttons: «تنظیم منوی کاربران» → `admin:menu_mode:user` ·
   «تنظیم منوی ادمین» → `admin:menu_mode:admin` ·
   «بازگشت به تنظیمات عمومی» → `admin:general_settings`.

2. **Scope page** — `admin:menu_mode:<user|admin>` shows one menu's
   current mode («نوع نمایش منوی کاربر» / «نوع نمایش منوی ادمین» +
   «نوع فعلی:» + the mode label), with «دکمه شیشه‌ای» →
   `admin:menu_mode:ask:<scope>:inline`, «دکمه معمولی» →
   `admin:menu_mode:ask:<scope>:reply` and «بازگشت» → `admin:menu_mode`.

3. **Confirm** — `admin:menu_mode:ask:<scope>:<inline|reply>`. Selecting
   the mode that is already active only answers with the toast
   «این نوع نمایش از قبل فعال است.» (no page change). Otherwise a
   per-scope confirmation page asks:

   - user → INLINE: «آیا منوی کاربر به حالت دکمه‌های شیشه‌ای داخل پیام تغییر کند؟»
   - user → REPLY: «آیا منوی کاربر به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟»
   - admin → INLINE: «آیا منوی ادمین به حالت دکمه‌های شیشه‌ای داخل پیام تغییر کند؟»
   - admin → REPLY: «آیا منوی ادمین به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟»

   with «تایید ✅» → `admin:menu_mode:set:<scope>:<mode>` and «انصراف» →
   `admin:menu_mode:<scope>`.

4. **Apply** — `admin:menu_mode:set:<scope>:<inline|reply>` re-checks the
   current mode (already active → the same «از قبل فعال» toast plus a
   re-render), otherwise stores the scoped setting, logs the change with
   the acting admin's id, scope and mode, answers the per-scope success
   toast — «نوع نمایش منوی کاربر با موفقیت تغییر کرد ✅» /
   «نوع نمایش منوی ادمین با موفقیت تغییر کرد ✅» — and re-renders the
   scope page.

The `<scope>` and `<mode>` callback parameters parse **fail-closed**:
anything other than `admin` means the user scope, anything other than
`reply` means `INLINE`.

## Operator-editable labels, duplicate guard, unseeded fallback

The 9 `admin_*` ButtonText rows are seeded in
`packages/database/src/seed-data.ts` (`INITIAL_BUTTON_TEXTS`) with
defaults equal to the exact approved historical inline labels — only the
top-level navigation labels are registry rows; deeper admin pages stay
code-level constants. They are edited like any other ButtonText row via
«تنظیمات عمومی ⚙️ → مدیریت متن‌ها ✍️» (1..64 characters; see
`docs/button-text-registry.md`), and edits apply immediately in both
modes because both renderers and the resolver read the current labels
per render.

| Key | Default (Persian) |
| --- | --- |
| `admin_finance` | مالی 💎 |
| `admin_users` | مدیریت کاربران 👤 |
| `admin_products` | مدیریت محصولات/پلن‌ها 📦 |
| `admin_panels` | مدیریت پنل‌ها 🖥 |
| `admin_other_products` | محصولات دیگر / سفارش‌های محصولات دیگر |
| `admin_support_tickets` | تیکت‌های پشتیبانی 🎫 |
| `admin_broadcast` | پیام همگانی 📣 |
| `admin_general_settings` | تنظیمات عمومی ⚙️ |
| `admin_reports_backup` | گزارشات / بکاپ 📊 |

**Per-menu duplicate-label guard**: because reply routing resolves
incoming text against the current labels of each menu, a main-menu label
may never equal another label of the *same* menu. `updateButtonText`
(`apps/bot/src/services/admin-text-settings.service.ts`) checks the edit
against two separate scopes — the 8 user `MAIN_MENU_BUTTON_KEYS` and the
9 `ADMIN_MAIN_MENU_BUTTON_KEYS` — and rejects a within-scope collision
with:

> این متن دکمه با یکی دیگر از دکمه‌های همین منو یکسان است.

The same label **may** exist in one user-menu button and one
admin-menu button simultaneously: the two menus are separate routing
contexts, and the router's fall-through rule (above) keeps such a shared
label working for non-admins. The resolver's fail-safe unmatched result
on ambiguous labels remains as defense in depth.

**Unseeded installs**: `getButtonText`
(`apps/bot/src/services/text.service.ts`) falls back from the DB row to
`BUTTON_FALLBACKS`, which is built from `INITIAL_BUTTON_TEXTS` — so an
installation that has not run the seed renders and routes the **identical
labels** in both renderers and the resolver (all three go through
`getButtonText`). The labels simply are not operator-editable until the
rows exist.

## Security invariants

- **Text never authorizes.** A label match only selects a candidate
  action; the sender must be an active admin and the action visible to
  them, or the router answers only the fixed denial
  «شما دسترسی لازم برای ورود به این بخش را ندارید.». `/admin` and every
  `admin:*` callback stay behind `adminAuthMiddleware` exactly as before.
- **Deactivated admins are denied, not passed through**: label matching
  is visibility-independent, so a deactivated admin tapping their stale
  persistent keyboard gets the denial (or, for a label shared with the
  live user menu, their ordinary user-context navigation) — never an
  admin section.
- **Reply buttons carry only safe top-level navigation**: no entity ids,
  no mutations. Sensitive/destructive operations remain Inline-only by
  construction, behind stable callbacks and their existing confirmations;
  deeper role gates (OWNER-only pages) are unchanged because both entry
  paths run the very same section landing functions.
- **Fail-closed parsing everywhere**: unknown setting values → `INLINE`;
  unknown `<scope>`/`<mode>` callback params → user scope / `INLINE`;
  ambiguous labels → unmatched.
- **The settings surface itself stays Inline in every mode**, requires an
  authenticated admin, confirms before applying, and logs every change
  with the acting admin's id.
- Labels never carry behavior (see `docs/text-system.md`): in both modes
  the action identity comes from the stable wiring, never from the
  Persian text.

## Limitations

- **Lazy, session-flagged removal** (same as the user side): the stale
  keyboard removal and the one-time «نوع منوی ربات تغییر کرده است.»
  notice happen on the chat's next main-menu render, not at the moment
  the setting flips. If the session store is cleared, the flag is lost
  and the stale keyboard simply stays visible — its taps remain inert in
  INLINE mode — until the next REPLY-mode render replaces it.
- The setting is global — individual admins cannot choose their own mode.
- REPLY mode cannot edit the menu in place (a Telegram limitation), so
  every admin menu render in REPLY mode adds a fresh message to the chat.
- Per-role menu hiding is not implemented yet: the visibility policy
  currently shows the full approved menu to every active admin, with role
  gates enforced inside the sections. `visibleActions` is the single
  place where centralized RBAC hiding will land.

## Purchase layout control (same «نوع نمایش منوها» page)

The admin-controlled unified purchase menu adds a «تنظیم چیدمان خرید 🛒» control
to the SAME «تنظیمات عمومی → نوع نمایش منوها» page (`text-settings.handler.ts`).
The overview shows «چیدمان خرید منوی کاربر: جداگانه/یکپارچه». All active admins
may VIEW the layout; only the live OWNER may mutate it (`requireOwner` re-checks
on the `admin:menu_buy:ask|set:<code>` callbacks; a regular admin gets an
OWNER-only toast). The change is an atomic compare-and-set against the observed
layout code and writes the privacy-safe `user_menu.purchase_layout_changed`
audit event. See `docs/combined-purchase-menu.md`.
