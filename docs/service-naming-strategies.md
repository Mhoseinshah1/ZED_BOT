# Service naming strategies (naming phase)

The admin panel has always exposed a per-panel "username creation method"
selector — but until this phase it was **write-only dead configuration**:
provisioning ignored it and every service was named by one hardcoded
generator (`zed_<telegramId>_<orderShort>`). This phase makes the selected
strategy **authoritative** across Marzban provisioning, XUI global-client
provisioning, retries, reconciliation, local Service persistence, admin
previews and Order snapshots.

Source: `apps/bot/src/services/service-naming.service.ts` (central
resolver), `provisioning.service.ts` (snapshot gate + usage),
`startup-recovery.service.ts` (reconciliation identity),
`handlers/panels/*` (admin UX).
Tests: `apps/bot/tests/service-naming.test.ts`,
`panel-provisioning-e2e.test.ts`, `startup-recovery.test.ts`.

## The EIGHT existing strategies (not five)

The task brief mentioned five strategies; the repository actually ships
**eight** (`UsernamePatternType`, stored on `Panel.usernamePatternType`
with default `TELEGRAM_ID_RANDOM`). All eight are preserved verbatim and
all eight are now functional:

| Enum value | Persian label | Resolved shape (v1) | Sources | Requires |
| --- | --- | --- | --- | --- |
| `TELEGRAM_USERNAME_SEQUENCE` | نام کاربری تلگرام + شماره ترتیبی | `{tg_username}_{seq}` | Telegram username (fallback below), panel sequence | — |
| `TELEGRAM_ID_RANDOM` (default) | آیدی عددی تلگرام + بخش تصادفی | `{telegram_id}_{random}` | Telegram id, random (len `usernameRandomLength` ?? 4) | — |
| `CUSTOM` | متن دلخواه + شناسه سفارش | `{custom_text}_{order_short}` | admin text, order short id (fully deterministic) | `usernameCustomText` |
| `CUSTOM_RANDOM` | تصادفی کامل | `{random}` | random only (len ?? 8, min 8) | — |
| `CUSTOM_TEXT_RANDOM` | متن دلخواه + بخش تصادفی | `{custom_text}_{random}` | admin text + random (len ?? 4) | `usernameCustomText` |
| `CUSTOM_TEXT_SEQUENCE` | متن دلخواه + شماره ترتیبی | `{custom_text}_{seq}` | admin text + panel sequence | `usernameCustomText` |
| `TELEGRAM_ID_SEQUENCE` | آیدی عددی تلگرام + شماره ترتیبی | `{telegram_id}_{seq}` | Telegram id + panel sequence | — |
| `REPRESENTATIVE_TEXT_SEQUENCE` | پیشوند نماینده + شماره ترتیبی | `{rep_prefix}_{rep_seq}` | representative prefix + its OWN sequence counter | `representativeUsernamePrefix` |

Sequences are the panel counters `usernameSequenceLastNumber` /
`representativeSequenceLastNumber`, reserved with an atomic increment —
consumed **once per order**, never on retries.

## Root cause of the original bug

`Panel.usernamePatternType` (+ its five supporting config columns) had no
reader: a repo-wide search showed the only references were the admin UI
that wrote them. `provisionPaidOrder` called the hardcoded
`generatePanelUsername` for the lock key, the adapter input and the
Service row — so selecting any strategy changed nothing.

## Configuration precedence

Naming is **panel-scoped by design** (the audited admin UX stores all
naming config on the Panel; no product- or category-level naming field
exists, and the Prisma default acts as the global default). A per-product
override was deliberately NOT added: the existing model is explicit and a
second layer would contradict it. Precedence is therefore:

```
Checkout-time capture of the panel's strategy + config
→ (legacy checkouts only) the panel's current strategy + config
```

Validation happens **before payment**: creating a SERVICE_PRODUCT
checkout is blocked with «اطلاعات لازم برای این روش نام‌گذاری کامل نیست.»
while the selected strategy is missing its required panel fields.

## The immutable order snapshot

`Order.namingSnapshot` (nullable Json) is written **exactly once**, before
the first remote mutation, by `ensureOrderNamingSnapshot` (compare-and-set
on `namingSnapshot IS NULL`; a concurrent first-provision race persists
exactly one winner):

```json
{
  "strategy": "CUSTOM_TEXT_SEQUENCE",
  "version": 1,
  "resolvedRemoteUsername": "shop_42",
  "resolvedDisplayName": "Shop_42",
  "sources": { "telegramId": "...", "telegramUsername": "...",
               "orderShort": "...", "customText": "...",
               "sequence": 42, "random": "..." }
}
```

After this point NOTHING can rename the paid order: Telegram username
changes, product/panel renames, admin strategy changes and category edits
are all invisible to it. Retries, the provisioning lock key
(`zedbot:service-provisioning:<panelId>:<username>`), reconciliation and
the created Service row all read the snapshot. The Service row also
persists `namingStrategySnapshot` ({strategy, version, resolved values});
`Service.username` = the remote technical identity, `note` = the user's
editable note, `productNameSnapshot` = the display product name — a user
editing a note can never touch the remote identity.

## Fallback for missing Telegram username

Strategies that use the Telegram username substitute the deterministic
`u{telegramId}` when the user has none — never `undefined`, `null`, `@`
or an empty string. It satisfies the provider charset and stays unique
through the strategy's sequence/order components.

## Normalization (provider profiles)

One shared profile covers both providers, audited separately: Marzban
usernames (rejects >32 chars; `[a-z0-9_]` is the repo's long-established
safe charset) and the pinned 3X-UI global-client email/label (free string;
the same charset and cap keep subscription and label handling safe):

- lowercase; every non-`[a-z0-9_]` run becomes one `_`
- collapsed separators; no leading/trailing separator
- never empty (order-derived fallback core)
- 32-char cap; truncation reserves the tail for the order short id so two
  truncated names can never collapse into the same value
- version `namingStrategyVersion = 1` recorded in every snapshot — if
  normalization ever changes, historical orders stay reproducible from
  their STORED resolved values (never recalculated)

## Collision policy (bounded, deterministic)

1. Build the strategy's base name and normalize it.
2. If a local Service belonging to a DIFFERENT order already owns that
   username, append the deterministic order-derived suffix and normalize
   again.
3. If that is also taken (different order), fail SAFELY
   («ساخت نام سرویس ناموفق بود. لطفاً تنظیمات نام‌گذاری را بررسی کنید.») —
   no unbounded retry loop, no adoption.

Name equality is NEVER ownership: the existing remote-recovery ladder
verifies the order marker note (`zedbot order:<short> tg:<id>`) before
recovering a remote account, and a foreign remote account is a safe
conflict.

## Marzban and XUI integration

Both adapters were already name-takers (`CreateServiceAccountInput.username`
is required input); neither generates names. The change is upstream: the
provisioning service passes `namingSnapshot.resolvedRemoteUsername`. For
XUI the global Client keeps `email = subId = username` — **no inbound ids
are ever appended** (the `username-<id>` shape exists only in the
legacy-read matcher). Reconciliation (`startup-recovery`) probes the
stored snapshot username, falling back to the legacy generator ONLY for
pre-naming-phase orders, whose remote accounts really do carry that name.

## Legacy records

- Existing Services keep their usernames exactly; their
  `namingStrategySnapshot` stays `null` (= LEGACY). Lifecycle operations
  always use `Service.username`.
- The migration adds nullable columns only — no UPDATE, no rename, no
  remote calls.
- Legacy PAID-but-unprovisioned orders resolve a fresh snapshot on their
  first (re)provision — safe because no remote account exists yet.
- Legacy in-flight (PROVISIONING) orders keep the historical generator so
  reconciliation probes the exact name their remote account carries.

## Admin UX

پنل‌ها → پنل → «تنظیمات username»: the page is titled
«روش نام‌گذاری سرویس» and shows «روش فعلی:» with the Persian strategy
name, its description, required fields, the missing-username fallback, the
32-char limit note and «نمونه نام ساخته‌شده:» (a live sample). Buttons:
«تغییر روش نام‌گذاری» (Persian-labeled selector; callback data stays the
stable strategy index) and «پیش‌نمایش نام‌گذاری» (regenerates the sample —
uses the NEXT sequence value without reserving it, sample Telegram
context, no order, no remote call). Saving answers
«روش نام‌گذاری با موفقیت ذخیره شد ✅», plus
«اطلاعات لازم برای این روش نام‌گذاری کامل نیست.» while required fields are
missing (checkout stays blocked until fixed).

## Free-trial accounts (trial note)

Free trials (`docs/free-trial-architecture.md`) use the **same eight
strategies** through the same resolver — `resolveVpnRemoteIdentity` takes
a generic subject, and for a trial the **`FreeTrialClaim` id replaces the
order id** as the deterministic source (the `orderShort` component, the
truncation tail and the collision suffix all derive from the claim id).
The resolved snapshot is frozen once (compare-and-set on
`FreeTrialClaim.usernameSnapshot IS NULL`) and persisted on BOTH
`FreeTrialClaim.namingSnapshot` (plus a `trialMarker` field) and the
created `Service.namingStrategySnapshot` — trial retries and
reconciliation reuse the stored identity exactly like paid orders reuse
`Order.namingSnapshot`. The trial ownership marker is
`zedbot trial:<claim-short> tg:<telegramId>` (the order marker's trial
counterpart). An incomplete naming config blocks trial activation and
trial claims the same way it blocks checkout.

## Privacy note

`TELEGRAM_USERNAME_SEQUENCE` embeds the buyer's public Telegram username
in the remote panel account name — visible to panel administrators.
Operators who consider that sensitive should prefer the id- or
text-based strategies. No other personal data (phone numbers, names) can
enter a name by construction, and secrets (panel credentials, tokens,
payment data) are not reachable by the resolver at all.

## Remaining limitations

- Sequence counters advance even when a later step fails (a skipped
  number, never a duplicate).
- `CUSTOM` with the same text on TWO panels can produce the same base for
  different orders' — the order-short component keeps them distinct.
- OTHER_PRODUCT naming is a separate, simpler system — see
  `docs/other-product-naming.md`.
