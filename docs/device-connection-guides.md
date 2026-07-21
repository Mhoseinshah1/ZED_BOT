# Device connection guides

Operator-managed, per-platform **"how to connect"** guides shown under every
eligible user Service (`آموزش اتصال 📱`). The guide helps a customer connect on
iPhone/iPad, Android, Windows, macOS, Linux and Android TV, and integrates with
the *existing* subscription/config text links, QR codes, support-ticket flow,
MessageTemplate/ButtonText system, owner-scoped Service lookup and safe Telegram
reply helpers — it is **not** a second help system.

Feature branch: `feat/device-connection-guides`.

## Architecture

| Layer | File |
| --- | --- |
| Shared contract (platform vocab, bounds, URL validator, setting key) | `packages/shared/src/connection-guides.ts` |
| Data model | `ConnectionGuideApp` in `packages/database/prisma/schema.prisma` |
| Core service (reads, cache, readiness, validation, mutations) | `apps/bot/src/services/connection-guide.service.ts` |
| User views (platform/app/guide pages) | `apps/bot/src/handlers/user-services/guide-views.ts` |
| User callbacks + detail button + link/QR/regen/post-purchase integration | `apps/bot/src/handlers/user-services/services.handler.ts`, `order-fulfillment.service.ts` |
| OWNER admin views + handler | `apps/bot/src/handlers/admin-settings/device-guides-views.ts`, `device-guides.handler.ts` |
| Seed copy + master switch | `packages/database/src/seed-data.ts`, `packages/database/src/seed.ts` |

## Master switch

Setting `connection_guides_enabled` (shared const `CONNECTION_GUIDES_ENABLED_KEY`),
default **`false`**. When disabled: no user-facing guide button is shown; any
stale/direct guide callback fails **closed** with a safe Persian notice; disabling
never deletes guide records; and the OWNER may only enable it once the readiness
gate passes (≥1 active, valid app). Typed readers live in the core service
(`isConnectionGuidesEnabled`, `enableConnectionGuides`, `disableConnectionGuides`).

## Data model (`ConnectionGuideApp`)

`id, slug (unique), platform, displayName, iconEmoji, primaryDownloadUrl,
alternateDownloadUrl?, supportsSubscription, supportsQr,
supportsIndividualConfigs, instructions, troubleshooting, isActive, sortOrder,
archivedAt?, createdAt, updatedAt, updatedByAdminId?`. Additive migration
`20260721121345_device_connection_guides` (CREATE TABLE + indexes only).

`platform` is a **typed String**, not a Postgres enum — matching the existing
`Panel.apiVariant` / `Panel.authMode` convention — so future devices can be added
without a non-transactional `ALTER TYPE … ADD VALUE`. The allowed values
(`IOS, ANDROID, WINDOWS, MACOS, LINUX, ANDROID_TV`) are validated in code.

Deletion is **soft**: `archiveGuideApp` sets `isActive=false` + `archivedAt` so an
audited record is never destroyed. No Service secret is ever stored in a guide row.

## Supported platforms & app capability flags

Platforms carry compact, immutable callback codes (`ios/and/win/mac/lin/atv`).
Each app declares which connection methods it supports: `supportsSubscription`,
`supportsQr`, `supportsIndividualConfigs`. A method is offered to the user only
when **both** the app supports it **and** the Service actually has that payload
(`resolveGuideMethods`).

## Owner-scoped routing (callback contract)

```
user:svc:guide:<sid>                     platform selection
user:svc:guide:<sid>:<pcode>             application selection for a platform
user:svc:guide:<sid>:<pcode>:<slug>      application guide page
user:svc:gsup:<sid>:<pcode>:<slug>       support handoff
```

`<sid>` = the existing 8-char Service short id, `<pcode>` = compact platform code,
`<slug>` = bounded app slug. Every callback stays well under Telegram's 64-byte
limit. Callback data **never** contains a subscription URL, config link, username,
Telegram id, full Service id, download URL or free-form app name.

Every route: (1) validates `ctx.dbUser`, (2) reloads the Service with
`getOwnedServiceByShortId`, (3) rechecks `connection_guides_enabled`, (4) reloads
the active guide app, (5) rejects another user's Service, (6) rejects inactive
apps, (7) answers the callback before rendering, and (8) never trusts session or
callback payload as authoritative data.

## User keyboard flow

`My Services → «آموزش اتصال 📱»` (rendered only when the master switch is on, an
active app exists, and the Service has a usable payload) → **platform page**
(only platforms with an active app) → **app page** (active apps, ordered
`sortOrder ASC, displayName ASC`, bounded to `GUIDE_MAX_ACTIVE_APPS_PER_PLATFORM`)
→ **app guide page**: escaped operator instructions + troubleshooting, a built-in
Service-status decision line, method buttons that **reuse the existing owner-scoped
callbacks** (`svcCb.link/qrSub/configs/qrConfigs`), validated-HTTPS download URL
buttons, status-eligible actions (enable/renew/extra-volume), a support handoff,
and back navigation. The `«آموزش اتصال 📱»` entry is also added to the subscription
text-link, subscription QR, config text, config QR summary, and regenerated-link
responses (always reloading the current Service).

`FAILED / CREATING / DELETED` services never render a usable-looking guide — they
show a safe status explanation + support only.

Every guide page is bounded to `GUIDE_PAGE_TEXT_MAX` (below Telegram's 4096-char
message limit). A fully populated app (3000 instruction + 2000 troubleshooting
characters) — or an operator who edits the intro/status/choose/handoff templates
to extreme lengths — would otherwise overflow and make **both** the edit and the
reply fallback fail silently, so every rendered guide message is clamped.

Guide template text is rendered as **escaped plain text** (`guideTemplateText`
escapes the whole rendered string, template + substituted values, once). The
operator edits templates with no HTML validation but they are sent with
`parse_mode: HTML`, so treating them as plain text means stray, crossed or
unclosed markup can never leave a malformed message that Telegram rejects. Only
the connection method / download / navigation buttons carry structured data.

An app is shown to a user only when it is usable for **that** Service — a supported
method backed by a real payload (`resolveGuideMethods(...).anyAvailable`). Platform
and application lists, the post-purchase entry gate and the detail page all apply
this filter (compatibility is checked **before** the per-platform cap so a usable
app is never hidden behind incompatible ones), and a stale/direct callback for an
incompatible app renders the safe unavailable + support variant.

## Why third-party links are operator-managed

No external application download URL is hardcoded in handlers, views, constants or
seed logic. The OWNER manages app names and official HTTPS download URLs from the
admin panel; the code only seeds platform labels, page templates, button labels
and empty-state copy. The master switch stays disabled until the OWNER configures
and activates at least one app.

## Why Service secrets are never embedded in download/deep links

A guide never builds a third-party deep link (e.g. `app://import?url=<secret>`)
and never appends the subscription URL/configs to text, a caption or a URL button.
Operator instructions are HTML-escaped and rendered verbatim (no placeholder or
Service-secret substitution). The user copies the existing text link or scans the
locally generated QR only — both stay behind the existing secure callbacks.

## Support handoff

`«هنوز وصل نمی‌شود؟ پشتیبانی 🛠»` routes into the **existing** ticket flow: it seeds
a safe subject (device + app, never a secret), stores a short-lived, ids-only
server-side context (`session.temp.guideSupportContext = { sid, pcode, slug }`),
and enters the support `message` flow. The prompt shows the selected service/device/
app; cancel returns to the exact guide page; the context is cleared with the support
draft. Another user cannot reuse the callback (the Service is reloaded owner-scoped).

## Admin readiness gate

The OWNER cannot enable the system unless: ≥1 active app; every active app has a
valid platform, a valid display name, a valid HTTPS primary URL, ≥1 supported
method and bounded valid instructions; no duplicate active slug; no invalid active
record (`evaluateGuideReadiness`). The readiness report lists counts and safe app
names only. Disabling is always available and never deletes configuration.

The "≥1 supported method" invariant is also enforced *at edit time*: an **active**
app's method toggle is rejected if it would remove the last remaining method (the
OWNER is asked to deactivate the app first), so an active app can never silently
become a `NO_METHOD` record while the switch is on. Reordering renumbers a
platform's apps to a gap-free `sortOrder` sequence, so up/down always moves one
display position even when apps previously shared a `sortOrder`.

## Caching

`connection-guide.service.ts` keeps a small, short-TTL (60s) in-memory cache of the
active apps used for user rendering — no Service/user data, bounded to the active
set, **invalidated on every admin mutation** (`invalidateGuideCache`), with a
direct-DB fallback. Admin reads are always fresh (uncached). No Redis dependency is
introduced for guide content.

## Privacy / logging

Audit events (`CONNECTION_GUIDE_CHANGED`, via `writeSystemLog`, topic `SECURITY`)
carry only `action`, `platform`, an 8-char app short id and the acting admin id —
never a User/Telegram/Service id, username, subscription URL, config link, QR
payload, full download URL, instructions body or the callback query object. The
QR/URL validators never echo the raw value in an error.

## Rollback & disable behavior

Disable the master switch from the admin panel (or set
`connection_guides_enabled=false`) to hide the entire feature instantly; guide
records are retained. The migration is additive — a full rollback drops the
`ConnectionGuideApp` table (no other table is touched). No existing behavior or
button route changes when the feature is off.

## Test coverage

- `apps/bot/tests/connection-guides-core.test.ts` — URL/slug validation, method
  resolution, readiness gate, bounded reads, cache, entry visibility.
- `apps/bot/tests/guide-user-ui.test.ts` — owner-scoping, disabled fail-closed,
  method rendering, stale app, no-secret-in-text/callbacks, support handoff.
- `apps/bot/tests/guide-admin.test.ts` — non-OWNER denied, create wizard,
  URL/name validation, enable gate, disable, archive, no-secret audit.
- `apps/bot/tests/guide-detail-postpurchase.test.ts` — detail button visibility,
  fail-soft post-purchase entry.
- `apps/bot/tests/navigation-integrity.test.ts` — every guide callback has a
  handler and stays < 64 bytes.

## Remaining limitations (later phases)

No automatic connection testing, device detection, deep-link import, install
tracking, external URL health checks or remote QR generation. QR codes remain the
locally generated ones from the QR phase; the guide only links to them.
