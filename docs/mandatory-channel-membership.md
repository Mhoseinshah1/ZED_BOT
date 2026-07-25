# Mandatory Channel Membership (Force Join)

When enabled, users must be live members of every configured active channel
before they can use the bot. This document describes the data model, the admin
configuration flow, the runtime membership gate, and the operational behaviour.

## Overview

- **Master switch:** the existing `force_join_enabled` Setting (reused, not
  duplicated). When `false`, no membership checks run.
- **Channels:** stored in the `ForceJoinChannel` table, configured entirely from
  admin-supplied **links** — an admin never types a numeric chat id.
- **Gate:** integrated into `ensureUserAccess`, preserving the order
  `maintenance → blocked → terms → force-join → normal`.
- **Membership is live state** — there is no "verified once" flag and no stored
  `joinedAt`; every gated interaction re-checks the current membership (cached
  briefly). `User.forceJoinBypass = true` skips the whole check.

## Data model

`ForceJoinChannel` (migration `20260725190000_force_join_channels`):

| Field | Notes |
| --- | --- |
| `id` | uuid, carried (as an 8-char prefix) in admin callback data |
| `title` | visible channel title captured at resolution (safe to show) |
| `joinUrl` | buyer-facing join URL (public: `https://t.me/<username>`; private: the invite link, preserved verbatim) |
| `normalizedLink` | dedup / identity key (public: normalized `https://t.me/<lower-username>`; private: the invite link) |
| `chatId` (BigInt) | internal Telegram peer id — **globally unique** (D5), never shown to users/admins/logs |
| `publicUsername` | lower-cased username without `@` (public only) |
| `isPrivate`, `isActive`, `sortOrder` | |
| `createdByAdminId` | soft reference |
| `lastValidatedAt`, `lastValidationErrorCode` | last bot-access validation result (normalized error class only) |

Constraints:

- `chatId` is **globally unique** — re-adding the same channel updates the
  existing row rather than inserting a duplicate (D5).
- `normalizedLink` is unique **only among public rows** via a partial unique
  index `WHERE "isPrivate" = false` (D6). Private invite links are never
  uniqueness-constrained.
- Ordering is deterministic: `(sortOrder ASC, createdAt ASC, id ASC)`. There is
  no `UNIQUE(sortOrder)`; reordering renumbers `sortOrder` contiguously.

The migration is additive and forward-only. Existing installs keep the
`force_join_enabled` Setting, the `force_join_text` template, and
`User.forceJoinBypass`.

## Link parsing (no SSRF)

`parseForceJoinLink` (in `@zedbot/shared`) is pure string logic — it **never**
issues a network request. It accepts:

- public: `https://t.me/<username>`, `https://telegram.me/<username>`,
  `t.me/<username>`, `@<username>`
- private: `https://t.me/+<hash>`, `https://t.me/joinchat/<hash>`

and normalizes public links to `https://t.me/<lower-username>` while preserving a
private invite hash byte-for-byte. It **rejects** external URLs, message links
(`t.me/x/123`), deep links (`t.me/proxy?…`, `t.me/share?…`, `tg://…`), reserved
paths (`s/`, `c/`, …), and any input containing control, zero-width, bidi, or
non-ASCII (homoglyph) characters — rejected, never "cleaned". The parser only
guarantees a *structurally* valid channel/invite link; whether the target is
actually a channel (vs a bot/user/group) is asserted later by Telegram at
`getChat` (§4.2).

## Internal identity resolution & bot-permission validation

At channel creation, activation, and on the "تست دسترسی ربات ♻️" action, the bot
runs `getMe → getChat → getChatMember(channel, botId)` (T9 order) and asserts the
bot is `administrator` or `creator` (D1). On failure it returns exactly:

```
ابتدا ربات را در کانال ادمین کنید و دوباره تلاش کنید.
```

- **Public channel:** the username is resolved via `getChat('@username')`; the
  **authoritative** username/title from `getChat` are persisted (not the admin's
  typed casing — T4).
- **Private channel:** an invite link is not a resolvable identity. The admin
  pastes the invite link (validated and held in session), the bot presents a
  `request_chat` channel picker (a temporary reply keyboard — request_chat only
  works there, not on an inline keyboard — T1/T2), the admin selects the channel,
  and the bot re-validates the resulting `chat_shared` via `getChat` +
  `getChatMember` before pairing it with the stored invite link. The
  `request_chat` `request_id` is session-bound, single-use, sender-checked, and
  time-limited (T3).

## Admin UI

Under `تنظیمات عمومی ⚙️`, section **`عضویت اجباری 📢`** (OWNER only; other roles
fail closed). Routing uses stable `admin:force_join:*` callbacks carrying the
channel id's short prefix — never a chat id, username, link, or Persian label.

Actions: enable / disable force join, add channel, edit link, re-pick channel
(private), test bot access, activate/deactivate, move up / move down, delete
(with confirmation). A maximum of **10 active channels** is enforced in the
service layer; an 11th channel is stored inactive rather than rejected.
Activating an inactive channel **re-validates bot access first** (getMe →
getChat → getChatMember) and refuses the transition if the bot is no longer an
admin, so the overview can never advertise a required channel that membership
evaluation would silently exclude as unverifiable. A successful **تست دسترسی
ربات ♻️** clears any previously-recorded validation error. The overview is
**paginated** (8 rows per page) so a long inactive list can never overflow
Telegram's message / keyboard limits.

Text entry uses session-bound flows; `انصراف`, `/admin`, `/start`, `/ping`,
`/paysupport`, and navigation unwind the flow safely and remove any temporary
reply keyboard — even for a command whose own handler is registered ahead of the
admin flow dispatcher (an early escape middleware clears the flow first). The
private-channel `request_chat` picker is only offered in a **private chat** with
the bot (Telegram forbids `request_chat` keyboards in groups); an attempt from a
group is rejected with a "use the bot's private chat" notice instead of stranding
the session in the picker flow. Editing a **public** channel's link adopts the
freshly-validated username/title only when it resolves to the **same** channel; a
link pointing at a different channel is rejected (use «افزودن کانال» to add a new
one) so the gate and the join screen can never diverge.

## Runtime gate & user screen

When `force_join_enabled` is on and the user is not bypassed, `ensureUserAccess`
reads the active-channel set **once** (§4.13) and evaluates membership:

- **Joined** in every active channel → the user proceeds.
- **Missing** one or more → the user sees the join screen: a header, one URL
  button per **missing** channel labelled `عضویت در <title>` (title escaped /
  truncated), a `بررسی عضویت ✅` check button, and an optional support row. The
  Telegram chat id never appears in the text, buttons, or callback data.
- **Temporary/network failure** → the gate fails closed without lying, showing:
  `بررسی عضویت موقتاً ممکن نیست. چند لحظه دیگر دوباره تلاش کنید.` (D2). The admin
  area stays reachable so an OWNER can repair the configuration.

Tapping `بررسی عضویت ✅` re-checks live membership (bypassing the negative cache),
debounced per user. On success it answers `عضویت شما تایید شد ✅` and shows the
normal menu — nothing about balance, orders, referral, or payment state changes.

### Membership status rule (§4.8)

Joined: `creator`, `administrator`, `member`, and `restricted` **only when**
`is_member === true`. Not joined: `left`, `kicked`, `restricted` without
`is_member`, and user/chat-not-found. A pending join request is **not**
membership.

## Enabled-state safety (never brick — D4)

- Disabled → no checks.
- Enabled + **zero active valid channels** → everyone passes. Enabling with no
  active channel is rejected with exactly:
  `ابتدا حداقل یک کانال معتبر و فعال اضافه کنید.`
- Removing/deactivating the **last active channel while enabled** is rejected;
  the admin is offered a combined atomic "disable force join + deactivate/delete"
  action (D3).

## Failure taxonomy & alerts (§4.11)

A membership check distinguishes: user-not-a-member, bot-lacks-access,
Telegram temporary/network failure, and channel-deleted/renamed. A channel the
bot can no longer verify is **excluded** from gating (so users are never bricked)
and raises a durable, privacy-safe OWNER alert (`writeSystemLog`, event
`force_join.channel_unverifiable`, SYSTEM topic), deduplicated per channel per
rolling window (Redis, with a process-local fallback). Logs carry only the
channel DB id, a normalized error class, and the `isPrivate` flag — never the
chat id, invite link, API token, or raw Telegram response.

## Caching (§4.12)

Membership verdicts are cached in Redis, bounded:

- joined → ~90s TTL, not-joined → ~10s TTL, API errors → never cached.
- Cache keys include the user id (string), the channel DB id, and the channel
  version (`updatedAt`), so any activation, edit, rebind, or deletion invalidates
  naturally. The `BigInt` chat id is never placed in a key (T6).
- Redis down → the cache is bypassed and Telegram is queried directly; a cache
  failure never fails the membership check (D8).
- The explicit `بررسی عضویت ✅` re-check bypasses the negative cache.

## Compatibility

- `User.forceJoinBypass` still bypasses the whole check.
- `force_join_enabled` is reused (not duplicated); `force_join_text` remains
  operator-editable. The join-page header is a new operator-editable
  `force_join_page` template defaulting to the §4.9 header.
- The terms flow and `/start` referral handling are unchanged. No existing user
  is auto-bypassed or permanently marked joined (D9).

### Interaction with the free-trial channel-membership option

The free-trial eligibility calculator has a **separate**, admin opt-in setting
(`freeTrialRequiresChannelMembership`) that predates this feature and denies a
trial when `force_join_enabled` is on and the user is not bypassed. It is a
coarse flag check, not a live membership check. Because the real force-join gate
now enforces membership **before** any user can reach the trial flow, that
option is redundant when force join is globally enabled. It is intentionally left
unchanged (no scope creep); operators who rely solely on the new gate can leave
`freeTrialRequiresChannelMembership` disabled.
