# User main-menu keyboard modes

The user main menu renders in one of two keyboard modes, selected by a
single global, admin-configurable setting: **inline** — glass buttons
inside the menu message (the historical behavior and the default) — or
**reply** — a persistent Telegram reply keyboard below the input field.
Only the keyboard *type* switches. The approved menu structure, labels,
ordering and visibility rules are one shared definition consumed by both
renderers, so the two modes can never drift apart. Admin menus are never
affected.

Code map:

| Concern | File |
| --- | --- |
| Setting (`user_main_menu_keyboard_mode`) | `apps/bot/src/services/menu-mode.service.ts` |
| Shared menu definition, reply renderer, text resolver | `apps/bot/src/keyboards/user-menu-definition.ts` |
| Inline renderer (same definition) | `apps/bot/src/keyboards/user-main.keyboard.ts` |
| Shared action dispatcher + reply text router | `apps/bot/src/handlers/user-menu-actions.ts` |
| Menu render mode branch + transition | `apps/bot/src/handlers/menu.handler.ts` |
| Admin settings page | `apps/bot/src/handlers/admin-settings/text-settings.handler.ts` |
| Duplicate-label guard on button edits | `apps/bot/src/services/admin-text-settings.service.ts` |
| Locked behavior | `apps/bot/tests/user-menu-keyboard-mode.test.ts` |

## The two modes

| Mode | Admin label (`MENU_MODE_LABELS`) | Rendering |
| --- | --- | --- |
| `INLINE` (default) | «دکمه شیشه‌ای داخل پیام» | `InlineKeyboard` attached to the menu message; buttons emit their stable callbacks (`user:buy`, …) exactly as before |
| `REPLY` | «دکمه معمولی پایین صفحه» | persistent `Keyboard` below the input field — `.resized().persistent()` with input placeholder «یک گزینه را انتخاب کنید»; buttons carry no callback data, they send their **text**, which the bot routes back to the same sections |

## The setting — default and no-migration behavior

- Key: `user_main_menu_keyboard_mode` (`USER_MENU_MODE_KEY`), a `STRING`
  Setting row with values `INLINE` / `REPLY`.
- One **global** value for the whole bot — there is no per-user preference.
- **Default `INLINE`, no migration required**: `getUserMenuMode()` resolves
  an absent row *and any unknown/garbage value* to `INLINE`. Existing
  installations keep their exact current behavior with no data migration,
  and a corrupted value can never crash the menu or half-enable the
  feature (fail-closed).

## Admin page: پنل ادمین → تنظیمات عمومی ⚙️ → نوع نمایش منوی کاربر

The general-settings landing (`admin:general_settings`) carries the
«نوع نمایش منوی کاربر» button. Every route below requires an
authenticated admin (`ctx.admin`), and a mode change always goes through
an explicit confirmation step:

1. **Mode page** — `admin:menu_mode` shows the current mode:

   > نوع نمایش منوی کاربر
   >
   > نوع فعلی:
   > دکمه شیشه‌ای داخل پیام

   Buttons: «دکمه شیشه‌ای» → `admin:menu_mode:ask:inline` ·
   «دکمه معمولی» → `admin:menu_mode:ask:reply` ·
   «بازگشت به تنظیمات عمومی» → `admin:general_settings`.

2. **Confirm** — `admin:menu_mode:ask:<inline|reply>`. Selecting the mode
   that is already active only answers with the toast
   «این نوع نمایش از قبل فعال است.» (no page change). Otherwise a
   confirmation page asks:

   - switching to INLINE: «آیا منوی کاربر به حالت دکمه‌های شیشه‌ای داخل پیام تغییر کند؟»
   - switching to REPLY: «آیا منوی کاربر به حالت دکمه‌های معمولی پایین صفحه تغییر کند؟»

   with «تایید ✅» → `admin:menu_mode:set:<mode>` and «انصراف» →
   `admin:menu_mode`.

3. **Apply** — `admin:menu_mode:set:<inline|reply>` re-checks the current
   mode (already active → the same «از قبل فعال» toast plus a re-render),
   otherwise stores the setting, logs the change with the acting admin's
   id, answers «نوع نمایش منوی کاربر با موفقیت تغییر کرد ✅» and
   re-renders the mode page. The `<mode>` callback parameter parses
   fail-closed: anything other than `reply` means `INLINE`.

## One menu definition, two renderers

`buildUserMainMenuDefinition()` in
`apps/bot/src/keyboards/user-menu-definition.ts` is the single source of
the user main menu: the approved row layout, eight **language-neutral
action identities**, and the shared visibility policy. Action identity
never derives from the visible Persian label — the stable wiring is
`MAIN_MENU_ACTION_WIRING` (action → ButtonText key + inline callback):

| Action | ButtonText key | Inline callback |
| --- | --- | --- |
| `BUY_SUBSCRIPTION` | `buy_subscription` | `user:buy` |
| `RENEW_SERVICE` | `renew_service` | `user:renew` |
| `MY_SERVICES` | `my_services` | `user:services` |
| `WALLET` | `wallet` | `user:wallet` |
| `OTHER_PRODUCTS` | `other_products` | `user:other_products` |
| `MY_ORDERS` | `my_orders` | `user:orders` |
| `SUPPORT` | `support` | `user:support` |
| `FREE_TRIAL` | `free_test` | `user:free_test` |

The approved layout is unchanged: three two-button rows
(buy+renew · services+wallet · other-products+orders), the conditional
free-trial row, then the support row.

The definition is **built fresh per render** — operator label edits and
free-trial availability changes apply immediately in *both* modes — and
the two renderers consume it verbatim:

- **Inline** (`buildUserMainKeyboard`, `user-main.keyboard.ts`): each
  button gets its current label and its stable callback. The approved
  inline contract (rows, order, callback data) is byte-for-byte what it
  was before this phase.
- **Reply** (`buildUserMainReplyKeyboard`): identical rows and labels,
  **no callback data anywhere** (reply buttons send their text). The
  keyboard is `.resized()`, `.persistent()` and sets the input
  placeholder «یک گزینه را انتخاب کنید». It is always built per
  user/request — never cached as one global keyboard — so a mid-request
  label edit or trial toggle cannot leak a stale layout.

## Reply text routing

Reply-keyboard buttons arrive as ordinary text messages, so REPLY mode
needs a text → action resolver and a router. Both are deliberately narrow.

### Exact current-label matching (`resolveMainMenuAction`)

- The incoming text is trimmed; empty strings and anything starting with
  `/` never resolve.
- It is compared for **exact equality** (after trimming) against the
  *current* labels of the visible menu definition — no substring, prefix
  or fuzzy matching. Arbitrary user text is never navigation.
- **Editable ButtonText compatibility**: because matching runs against the
  current labels, an operator-edited label keeps routing immediately (the
  text cache is cleared on every edit) and the *old* label stops routing
  at the same moment.
- **Ambiguity fails safe**: exactly one label match resolves to its
  action; zero or multiple matches resolve to `null` and the message
  falls through untouched.

### Duplicate-label prevention (edit-time guard)

Ambiguity should never occur in practice because it is blocked where it
would be created: `updateButtonText` in
`apps/bot/src/services/admin-text-settings.service.ts` rejects any edit
that would make one of the 8 main-menu ButtonText keys
(`MAIN_MENU_BUTTON_KEYS`) equal to another main-menu button's current
label, with:

> این متن دکمه با یکی دیگر از دکمه‌های منوی اصلی یکسان است.

The guard is scoped to the 8 main-menu keys only — all other ButtonText
rows are unaffected. The resolver's fails-safe `null` on multiple matches
remains as defense in depth (e.g. rows edited outside the bot).

### One dispatcher, the same section entries

`openMainMenuSection` (`apps/bot/src/handlers/user-menu-actions.ts`) maps
each action to the **exact section entry function the inline callback
already uses** — `startBuyFlow`, `renderRenewableList`,
`renderServicesList`, `renderWallet`, `openOtherProductsSection`,
`renderOrdersHub`, `renderSupportLanding`, `openFreeTrialSection`. No
callback queries are synthesized and no business logic is duplicated:
a reply-keyboard tap and an inline click run identical flows, with all
ownership/eligibility checks living in those flows.

## Active-flow priority

The reply text router (`userMenuTextRouter`) is registered in `app.ts`
**after** the flow-gated message dispatcher, so every active
conversational flow (discount entry, support messages, receipt uploads,
admin text edits, …) has already consumed its text before the router
runs. Inside the router the checks run in this order, and everything that
does not fully match falls through untouched:

1. an active flow (`ctx.session.currentFlow !== null`) → pass through
   (**flow text first** — defense in depth on top of the registration
   order);
2. text starting with `/` → pass through (**commands always win**);
3. mode is not `REPLY` → pass through (in INLINE mode the router is
   completely inert — typed labels are just text);
4. no exact label match (`resolveMainMenuAction` → `null`) → pass
   through;
5. only now the user access gates run (maintenance / blocked / terms /
   force-join via `ensureUserAccess`) — **after** a real menu label
   matched, so unrelated text from gated users never triggers gate
   messages;
6. the matched section opens via `openMainMenuSection`.

## Mode transitions and keyboard removal

`showUserMenu` (`apps/bot/src/handlers/menu.handler.ts`) branches on the
mode at render time (`/start`, `/menu`, `user:menu`, `common:back`):

- **REPLY**: the menu is always a **fresh message** carrying the
  persistent keyboard — Telegram cannot attach reply keyboards via
  `editMessageText` — and `ctx.session.replyMenuKeyboardActive` is set to
  `true`.
- **INLINE** for a user whose session still has
  `replyMenuKeyboardActive === true`: the bot first sends the one-time
  transition notice

  > نوع منوی ربات تغییر کرده است.

  with `remove_keyboard: true`, clears the flag, and then renders the
  inline menu as usual (edit-in-place for callbacks, fresh reply for
  commands). The notice appears **exactly once** per transition — later
  menu renders show only the inline menu.

Nothing is broadcast when the admin flips the setting; the transition is
lazy and quiet, per user, on their next main-menu interaction. In the
interim window:

- after REPLY → INLINE, taps on the stale reply keyboard send plain text
  that the router ignores (mode is not REPLY), so they are inert until
  the next menu render removes the keyboard;
- after INLINE → REPLY, old inline menu messages keep working because the
  inline callbacks are stable and stay registered.

## Free-trial visibility parity

The FREE_TRIAL row exists in the definition only while
`isFreeTrialVisible()` is true (feature enabled and ≥ 1 trial-ready
panel — see `docs/free-trial-architecture.md`). Since both renderers
*and* the text resolver consume the same definition, parity is automatic:

- while hidden, the trial button appears in neither mode, and **typing
  the trial label resolves to nothing** — a hidden feature cannot be
  forged by text;
- while visible, the trial label routes to `openFreeTrialSection`, which
  still re-checks eligibility server-side on every step.

## Admin menus stay inline

The mode applies to the **user main menu only**. The admin panel and all
admin pages keep their inline keyboards regardless of the setting.
Additionally, the reply text router can only ever resolve the 8 user
main-menu actions — admin actions are unreachable by text by
construction (the tests prove that typing «پنل ادمین» resolves nothing).

## Security notes

- **Matching text never authorizes anything.** A label match only selects
  which section entry runs; the user access gates
  (maintenance / blocked / terms / force-join) run before the section
  opens, and every section handler keeps its own ownership and
  eligibility checks — identical to the inline path. A blocked user
  typing a menu label gets the gate message, never the section.
- Matching is exact-only against current labels; unknown text falls
  through silently, so the router cannot be used to probe the bot.
- Everything parses fail-closed: unknown setting values → `INLINE`,
  unknown admin callback mode params → `INLINE`, ambiguous labels →
  no action.
- The admin settings routes (`admin:menu_mode*`) all require an
  authenticated admin and confirm before applying.
- Labels still never carry behavior (see `docs/text-system.md`): in both
  modes the action identity comes from stable wiring, never from the
  Persian text.

## Limitations

- **Lazy, session-flagged removal**: the stale-reply-keyboard removal
  relies on the per-user `replyMenuKeyboardActive` session flag, so the
  removal (and the one-time «نوع منوی ربات تغییر کرده است.» notice)
  happens on the user's **next main-menu interaction**, not at the moment
  the admin switches modes. If the session store is cleared, the flag is
  lost and the notice never fires — the stale keyboard simply stays
  visible (its taps remain inert in INLINE mode) until the user renders
  the menu in REPLY mode again.
- **Single-language labels today**: labels are Persian-only, but routing
  is keyed to the language-neutral action identities, so adding
  multi-language labels later means extending the resolver's label set —
  the wiring, callbacks and dispatcher stay unchanged.
- The setting is global — individual users cannot choose their own mode.
- REPLY mode cannot edit the menu in place (a Telegram limitation), so
  every menu render in REPLY mode adds a fresh message to the chat.

## What the tests prove

`apps/bot/tests/user-menu-keyboard-mode.test.ts` (requires a real
PostgreSQL via `DATABASE_URL`; skips otherwise — see `docs/testing.md`):

- **Setting semantics**: default `INLINE` on an absent row, switchable
  both ways, idempotent re-selection, garbage stored values resolve to
  `INLINE` without crashing.
- **Rendering parity**: the inline contract is unchanged (4 rows with the
  exact callbacks in order, trial hidden); the reply keyboard mirrors the
  same rows/labels/order with no callback data anywhere, is
  resized + persistent (not one-time), and every label fits Telegram's
  practical 64-character bound.
- **Routing**: every visible label resolves to its wired action; unknown
  text, commands and «پنل ادمین» never resolve; the hidden free-trial
  label does not resolve; an edited label routes while the old label
  stops; a second main-menu button edited to the same text is rejected
  with the exact duplicate-label message and the row is unchanged.
- **Priority and mode gating**: with an active flow
  (`support:message`, `checkout:discount`, `other_product:info`,
  `admin_texts:button`) the text falls through untouched; `/menu` falls
  through; in INLINE mode typed labels fall through; in REPLY mode with
  no flow the label opens the real section while arbitrary text still
  falls through silently.
- **Security**: a BLOCKED user typing a label gets the gate response and
  the section never renders; a forged hidden-trial label falls through.
- **Transitions**: REPLY renders a fresh persistent keyboard and sets the
  session flag; switching back to INLINE produces exactly one
  «نوع منوی ربات تغییر کرده است.» + `remove_keyboard` message followed by
  the inline menu, with no repeated notice on later renders.
