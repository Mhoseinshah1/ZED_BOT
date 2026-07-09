# ZED_BOT bot foundation (Phase 3)

Phase 3 turns the bot placeholder into the real grammY application
foundation: typed context, session, middleware chain, database-backed user
registration, referral capture, access gates, and the user/admin menus with
placeholder pages. **No business logic exists yet** — every menu section
replies with a placeholder.

Source: `apps/bot/src/`

## Structure

```
apps/bot/src/
  index.ts                 # lifecycle: token check, DB connect, polling, shutdown
  app.ts                   # createBot(): middleware chain + composer wiring
  config/env.ts            # TELEGRAM_BOT_TOKEN access (never logged)
  core/                    # context type, session shape, callback constants,
                           # logger, central error handler
  middlewares/             # rate-limit, attach-user, user-access, admin-auth
  services/                # user, admin, settings, text, referral (no grammY imports)
  keyboards/               # user main, admin main, back/common
  handlers/                # start, menu, ping, admin, terms, force-join,
                           # user/admin placeholder pages
  utils/                   # {variable} template rendering, safe reply/edit helpers
```

Middleware order: `rate limit → session → attach user/admin →` then per area:
`/ping` and `/start` are gate-free composers (`/start` runs the gates inline
*after* registration + referral), `terms:accept` / `force_join:check` handle
their own gate re-check, `admin:*` sits behind admin auth, and `/menu` +
`user:*`/`common:*` sit behind the user access guard.

## Commands

| Command | Behavior |
| --- | --- |
| `/start [referralCode]` | Registers/refreshes the user (username, names, language, `isBot`, `lastSeenAt`, `joinedAt` on create, `referralCode` = telegramId when missing), applies the referral payload when eligible, runs the access gates, shows the main menu |
| `/menu` | Access gates → main menu |
| `/admin` | Active-admin check → admin menu (or access denied) |
| `/ping` | `pong` (bypasses all gates — liveness check) |

## Access gates (in order)

1. **Bot off**: `maintenance_mode` setting → replies with `bot_off_text`.
2. **User status**: `BLOCKED` / `DISABLED` / `DELETED` → replies
   «دسترسی شما به ربات محدود شده است.» Admins with an active `Admin` row keep
   `/admin` access regardless of their `User.status`.
3. **Terms placeholder**: when `terms_required` = true and
   `termsAcceptedAt` is null → placeholder text + accept button
   (`terms:accept` stamps `termsAcceptedAt`, re-checks the gates, shows the
   menu).
4. **Force-join placeholder**: when `force_join_enabled` = true and the user
   has no `forceJoinBypass` → placeholder text + check button
   (`force_join:check` currently always "passes"; real `getChatMember`
   verification is a later phase).

## Referral capture (`/start 123456789`)

Numeric payload → referrer looked up by `referralCode` or `telegramId`;
applied only when the user has no referrer and isn't referring themselves.
Sets `referrerId` + `referralJoinedAt` and creates the `Referral` row.
No gifts, no commissions yet. Failures are logged and never break `/start`.

## User menu callbacks

`user:menu` (also `common:back`) renders the menu; sections:
`user:buy`, `user:renew`, `user:services`, `user:wallet`, `user:referral`,
`user:free_test`, `user:wheel`, `user:tutorials`, `user:support`,
`user:pricing`, `user:representative_request`, `user:other_products`.

Every section replies «این بخش در فاز بعدی تکمیل می‌شود.» with the section
title and back/main-menu buttons. The support section shows the operator
editable `support_text` template instead of the generic placeholder.

## Admin menu callbacks

`admin:menu` plus: `admin:finance`, `admin:panel_features`,
`admin:update_bot`, `admin:receipts`, `admin:tutorials`,
`admin:general_settings`, `admin:mini_app_settings`, `admin:users`,
`admin:products`, `admin:panels`, `admin:custom_service_price`,
`admin:other_products`, `admin:reports_backup` — all placeholder pages with a
back button. Any `isActive` admin passes regardless of role; role-based
restrictions arrive with the real admin sections.

## Text / template fallback behavior

`getSetting` / `getBooleanSetting` / `getMessageTemplate` / `getButtonText`
read from the database with a 30-second in-memory cache. When the database is
unavailable or a key is missing they fall back to hardcoded Persian defaults
(mirroring the seed) — the bot never crashes over a text lookup. Templates
render `{variable}` placeholders; unknown variables stay unchanged, and
button texts are used verbatim (literal `{تست}` stays intact).

## Intentionally NOT implemented in Phase 3

Purchases, checkout, payments, wallet charging, receipt review, Marzban/XUI
calls, service provisioning, product management, support ticket UI, real
broadcast sending, real channel-join verification, admin CRUD sections, web
panel, mini app. The in-memory rate limit (20 updates / 3s per user, silent
drop) is a placeholder — Redis-backed limiting is a TODO for a later phase.
