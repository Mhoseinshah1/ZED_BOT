# Free-trial VPN accounts — architecture

The free-trial feature gives an eligible Telegram user ONE real VPN
account (real remote panel account, real local `Service`) with an
admin-configured duration and traffic quota, at zero cost and with **zero
interaction with the payment system**.

Source of truth:
`apps/bot/src/services/free-trial.service.ts` (claim, provisioning,
reconciliation, sweep),
`apps/bot/src/services/free-trial-settings.service.ts` (global settings),
`apps/bot/src/handlers/user-free-trial/free-trial.handler.ts` (user flow),
`packages/database/prisma/schema.prisma` (`FreeTrialClaim`,
`FreeTrialClaimStatus`, `ServiceSource`, `Panel.test*`) and the migration
`packages/database/prisma/migrations/20260716000000_free_trial_accounts/`.
Tests: `apps/bot/tests/free-trial.test.ts` (real PostgreSQL + Redis + mock
Marzban/XUI panels).

**The feature is DISABLED by default** — fresh and existing installations
behave identically until an operator turns it on (see
`docs/free-trial-admin-management.md`).

## Entitlement model

A trial is a **separate entitlement type**, not a discounted purchase:

```
FreeTrialClaim  ──provisions──►  remote panel account
      │                                │
      └──────► Service (source FREE_TRIAL, serviceLocation TEST,
               orderId NULL, productId NULL)
```

- The `FreeTrialClaim` row — **not** a `Payment` or `Order` — is the
  entitlement record. It is created atomically and drives provisioning,
  reconciliation and expiry.
- A trial is **never a zero-price checkout**: no `CheckoutSession`, no
  `Order`, no `Payment`, no `WalletTransaction`, no discount usage, no
  referral effects, no paid counters (see the financial-isolation table
  below).
- The resulting `Service` is real: it appears in «سرویس‌های من», supports
  live sync, stored subscription links and configs — but it is a
  **read-only entitlement**: `resolveServiceDetailActions` hides renewal,
  extra volume, extra time, enable/disable and link regeneration for
  `source === "FREE_TRIAL"`. Its detail page is explicitly marked
  «نوع سرویس: اکانت تست رایگان»
  (`apps/bot/src/handlers/user-services/service-views.ts`).
- `Service.source` (`ServiceSource`: `PAID` default / `FREE_TRIAL` /
  `ADMIN_CREATED`) records the entitlement origin; all pre-existing
  services stay `PAID`.

## Claim status machine

`FreeTrialClaimStatus`:

```
            insert            remote create ok        expiresAt passed
 (none) ──► CLAIMED ──► PROVISIONING ──► ACTIVE ──► EXPIRED
               │              │  ▲
               │              │  └── retry / reconcile (same frozen identity)
               │              │
               │              ├─ definite remote failure ──► FAILED
               │              ├─ attempts/age exhausted ───► MANUAL_REVIEW
               │              │      (reconcile: APPLIED ► ACTIVE,
               │              │       NOT_APPLIED ► FAILED)
               │              └─ lock unavailable, attempt 0 ► CANCELLED
               └─ capacity lost / stale (>15 min) ─────────► CANCELLED
```

| Status | Meaning | Consumes entitlement? | Occupies capacity? |
| --- | --- | --- | --- |
| `CLAIMED` | inserted, not yet at the panel | yes (in progress) | yes |
| `PROVISIONING` | remote create in flight / outcome unknown | yes (in progress) | yes |
| `ACTIVE` | remote account exists, `Service` persisted | yes | yes, until `expiresAt` |
| `EXPIRED` | trial window ended | yes (lifetime/cooldown policy) | no |
| `FAILED` | positively nothing exists remotely | **no — retry allowed** | no |
| `CANCELLED` | released before any remote effect | **no — retry allowed** | no |
| `MANUAL_REVIEW` | reconciliation exhausted, admin alerted | yes (in progress) | yes |

"Consumes entitlement" = the status is in `CONSUMING_STATUSES`
(`CLAIMED`, `PROVISIONING`, `ACTIVE`, `MANUAL_REVIEW`, `EXPIRED`).
`FAILED`/`CANCELLED` rows never block a retry. `EXPIRED` rows enforce the
admin policy: with `free_trial_once_per_user` on (default) they block
forever; otherwise `free_trial_cooldown_days` applies from the claim's
`createdAt`.

## The atomic claim (insert-first)

Two things must never happen no matter how many callbacks race: a user
getting two live claims, and a panel exceeding its capacity. Both are
decided by PostgreSQL, not by application reads.

**1. One live claim per user — partial unique index.** The migration
creates:

```sql
CREATE UNIQUE INDEX "FreeTrialClaim_userId_live_key" ON "FreeTrialClaim"("userId")
WHERE "status" IN ('CLAIMED', 'PROVISIONING', 'ACTIVE', 'MANUAL_REVIEW');
```

`insertClaim` inserts FIRST: twenty simultaneous confirms produce one
insert and nineteen instant `P2002` unique-violation denials (rendered as
«در حال حاضر ساخت اکانت تست شما در حال انجام است.») with no transaction
pile-up on the pool. The eligibility reads before the insert are only a
policy gate (once-per-user / cooldown over `EXPIRED` rows, which the
index deliberately excludes so that policy stays admin-configurable);
concurrent duplicates cannot slip through them because they collide on
the index regardless of what the reads saw. Proven by test 21 (20
simultaneous confirms → 1 claim, 1 remote create call, 1 service).

**2. Per-panel capacity — advisory lock.** When
`Panel.testMaxConcurrentAccounts` is set, capacity is decided AFTER the
insert, in a tiny transaction serialized by
`pg_advisory_xact_lock(hashtext('zedbot-free-trial-panel:<panelId>'))`:
the oldest claims within the limit (live statuses + unexpired `ACTIVE`)
win; a losing insert cancels **itself** (`CANCELLED`,
`failureReasonCode = "capacity-full"`, user text «ظرفیت اکانت تست این
لوکیشن تکمیل شده است. لطفاً بعداً تلاش کنید.»). Count-then-insert
over-allocation is impossible. `null` capacity = no cap. Slots free up
when a claim leaves the live set (expiry, failure, cancellation). Proven
by test 22 (two users race the last slot → exactly one wins).

**3. Fail-closed Redis.** `isLockBackendAvailable()` is probed **before
any claim is written** — if the coordination backend is down the user is
denied with «ساخت اکانت تست موقتاً امکان‌پذیر نیست…» and nothing is
consumed. The remote create itself runs under the same distributed
provisioning lock as paid provisioning
(`zedbot:service-provisioning:<panelId>:<username>`). If that lock cannot
be acquired:

- `attemptCount === 0` and reason `unavailable` → nothing remote can have
  happened; the claim is released (`CANCELLED`,
  `failureReasonCode = "lock-unavailable"`) and the user may retry later;
- otherwise → a previous attempt may have reached the panel; the claim is
  KEPT for reconciliation (outcome `uncertain`), never released.

## Remote identity and naming

The remote username is resolved by the panel's configured naming strategy
via `resolveVpnRemoteIdentity({ id: claim.id }, user, panel.id,
namingConfigFromPanel(panel))` — the **claim id takes the role the order
id plays for paid services** as the deterministic component (see
`docs/service-naming-strategies.md`).

The identity is **frozen exactly once** with a compare-and-set on
`FreeTrialClaim.usernameSnapshot IS NULL`; a concurrent freezer loses the
CAS and reuses the stored value. `FreeTrialClaim.namingSnapshot` persists
`{ strategy, version, resolvedRemoteUsername, resolvedDisplayName,
trialMarker }`, and the same snapshot lands on
`Service.namingStrategySnapshot`. Every retry and every reconciliation
probe uses the frozen `usernameSnapshot` — retries can never mint a
second account under a different name.

The **ownership marker** is written as the remote account note:

```
zedbot trial:<first 8 chars of claim id> tg:<telegramId>
```

(`trialOwnershipMarker`) — the trial counterpart of the paid
`zedbot order:<short> tg:<id>` marker. Name equality alone is never
treated as ownership.

## Remote provisioning per panel type

Both adapters receive the exact trial quota and expiry;
`durationDays = max(1, ceil(minutes / 1440))` is passed for adapter/
`Service.durationDays` compatibility, but the precise `expiresAt`
(claim `createdAt` + `testDurationMinutes`) governs the remote expiry.

| Aspect | Marzban | XUI (Sanaei global client) |
| --- | --- | --- |
| Account shape | panel user (from `templateUsername` / protocol settings) | **exactly ONE global client**; `email = subId = username` |
| Traffic quota | `data_limit` in **bytes** (`testVolumeMb * 1024²`) | `totalGB` field carries **bytes** despite its name |
| Expiry | `expire` in **unix seconds** | `expiryTime` in **unix milliseconds** |
| Inbounds | template/protocol-settings driven | `Panel.testInboundIds` — the SELECTED trial inbounds only, validated as a non-empty subset of `Panel.inboundIds` |
| Ownership marker | account `note` | account note/label per the pinned contract |

Verification follows the shared adapter outcome model
(`docs/panel-capabilities.md`): definite success, definite failure
(nothing exists remotely), or `uncertain: true` (UNKNOWN). The
integration tests assert the exact remote bytes, expiry timestamps,
marker note, and that XUI issues exactly one add-client call attaching
only the selected trial inbounds.

On definite success one transaction (`persistTrialService`) creates the
`Service` (`source FREE_TRIAL`, `serviceLocation TEST`, `orderId null`,
`productId null`, `productNameSnapshot = panel.testProductName ??`
«اکانت تست رایگان», stored subscription URL/token/config links) and
CAS-flips the claim to `ACTIVE` (`serviceId`, `provisionedAt`,
`expiresAt`). Only if that CAS wins do the trial counters move
(`User.testAccountsCreatedCount`, `User.lastTestAccountCreatedAt`) —
never any paid statistic. A `P2002` on the unique `Service.username`
adopts the row already persisted by a concurrent/prior attempt of the
SAME user; a foreign owner is a hard error.

## UNKNOWN outcomes and reconciliation

An UNKNOWN remote outcome (timeout after the panel may have applied the
mutation, crash mid-call, lock lost after attempt 1) **never issues a
second account and never consumes or releases the entitlement without
reconciliation**:

- the claim stays `PROVISIONING`; the user sees «نتیجه ساخت اکانت تست
  هنوز مشخص نیست و در حال بررسی است.» and is deliberately NOT invited to
  retry (the live-claim index blocks a retry anyway);
- `reconcileTrialClaim` re-checks the panel by the **exact frozen
  username** via `getServiceAccount` and returns one of:

| Outcome | Evidence | Action |
| --- | --- | --- |
| `APPLIED` | account exists remotely | recover: persist the `Service`, claim → `ACTIVE`, notify the user once with the normal success message |
| `NOT_APPLIED` | positively absent (`notFound`) | claim → `FAILED` (`reconciled-not-applied`) — entitlement released, retry allowed |
| `UNKNOWN` | panel unreachable / ambiguous | defer; nothing changes |

Proven by tests 24/25: a create that stores remotely but times out
reconciles to `APPLIED` with exactly one `Service`; repeated
reconciliation converges (an already-`ACTIVE` claim is a no-op).

## The sweep loop

`startFreeTrialLoop` (wired in `apps/bot/src/index.ts`) reschedules
`runFreeTrialSweep` every 60 s (batch 20, never throws):

1. **Expiry** — `ACTIVE` claims past `expiresAt`: claim → `EXPIRED` and
   the trial `Service` → `EXPIRED` (both CAS). When the panel has
   `testAutoDisableAfterExpiry` on, the remote account is additionally
   disabled via `setServiceStatus` (best-effort; failures are logged and
   retried on no schedule). **Without that flag there is no automatic
   remote deletion or disabling of expired trials** — the remote account
   simply keeps its own quota/expiry limits.
2. **Stale claims** — `CLAIMED` rows older than 15 minutes never reached
   the panel: released as `CANCELLED` (`stale-claim`).
3. **Reconciliation** — `PROVISIONING` claims idle for ≥ 1 minute are
   reconciled; `APPLIED` recoveries notify the user once.
4. **Manual-review escalation** — a claim still UNKNOWN after
   `TRIAL_MAX_PROVISION_ATTEMPTS = 3` attempts or 60 minutes escalates to
   `MANUAL_REVIEW`, and every active OWNER admin is DM'd a safe alert
   («⚠️ اکانت تست نیازمند بررسی» + claim short id, status, attempt
   count — no credentials, no links). This is a direct DM because the
   LogTopic emit infrastructure does not exist yet (see limitations).

## Financial isolation — guarantees

A trial claim, whatever its outcome, writes **none** of the following.
Locked by the integration tests (`free-trial.test.ts`, "zero financial
writes"):

| Financial object / counter | Trial effect |
| --- | --- |
| `Payment` | none |
| `WalletTransaction` / `User.balanceToman` | none |
| `Order` / `CheckoutSession` | none (`Service.orderId` is NULL) |
| `DiscountCodeUsage` | none |
| `ReferralCommission` / referral counters | none |
| `User.ordersCount`, `User.paidOrdersCount`, `User.totalPurchaseAmountToman` | unchanged |
| Revenue / financial reports (order- and payment-based) | trials invisible by construction |
| `User.testAccountsCreatedCount`, `User.lastTestAccountCreatedAt` | **only** these move, once per activated claim |

The migration is equally isolated: it touches no `Service`/`Payment`/
`Order` rows, changes no balances and fabricates no claims. The unused
`TestAccountHistory` placeholder table was **renamed in place** to
`FreeTrialClaim` (preserving any manual rows), and every pre-existing row
was set to `CANCELLED` with `failureReasonCode = 'legacy placeholder
row'` — legacy rows carry no lifecycle evidence and must never consume a
user's entitlement.

## User flow and gating

The main-menu button «اکانت تست رایگان 🎁» (`ButtonText` key `free_test`,
callback `user:free_test`) renders **only** when
`isFreeTrialVisible()`. Since the shared availability policy landed,
that is a thin view over **`getFreeTrialMenuAvailability()`** — the ONE
classifier consumed by the user menu (both the inline keyboard and the
reply-keyboard mode render from the same `user-menu-definition.ts`
rows), the user panel list and the OWNER admin diagnostics page
(«تنظیمات اکانت تست 🎁» under «تنظیمات عمومی ⚙️»). It returns a
structured result:

```ts
interface FreeTrialMenuAvailability {
  visible: boolean;          // globallyEnabled && readyPanelCount > 0
  globallyEnabled: boolean;  // Setting free_trial_enabled (default false)
  readyPanelCount: number;   // claimable RIGHT NOW
  incompletePanelCount: number;
  reason:
    | "AVAILABLE"
    | "GLOBAL_DISABLED"
    | "NO_READY_PANEL"          // no ACTIVE + testEnabled candidates at all
    | "NO_VALID_XUI_INBOUND"    // every incomplete candidate blocks on XUI inbounds
    | "PANEL_CONFIG_INCOMPLETE";
}
```

"Ready" means `ACTIVE` + `testEnabled` + `assessTrialPanelConfig` passes
**and free capacity remains** (`testMaxConcurrentAccounts` exhaustion is
the `capacity-full` reason code): a full panel drops out of the count,
so the button can never open onto an immediately-denied flow. There is
deliberately no readiness cache — the classifier reads the database per
render, so per-panel trial edits, readiness-test results and
active/inactive flips apply to the very next menu render without a bot
restart; the global switch sits in the 30s settings cache, which the
admin enable/disable flow clears on every flip. A fully operational
section or no button at all — never a visible placeholder. The button's
visibility check is global-only by design (the approved UX): per-user
eligibility runs when the button is pressed, not when it is rendered.

Flow: button → eligibility check → panel/location list
(`user:ft:p:<sid>`, label = `testLocation ?? name` + duration/traffic) →
confirmation page (specs + optional `free_trial_notice_text` +
«هر کاربر فقط طبق قوانین تعیین‌شده امکان دریافت تست دارد.») →
«دریافت اکانت تست ✅» (`user:ft:go:<sid>`) → atomic claim + provisioning.
Nothing from callback data is trusted: the short id only selects WHICH
trial-ready panel, and every value is re-read from the database inside
the service. Success sends the username, duration, traffic and
subscription link — to the owner only.

Denial texts (verbatim service constants): «شما قبلاً از اکانت تست
رایگان استفاده کرده‌اید.» · «در حال حاضر ساخت اکانت تست شما در حال انجام
است.» · «در حال حاضر پنل فعالی برای ارائه اکانت تست وجود ندارد.» ·
«ساخت اکانت تست موقتاً امکان‌پذیر نیست. لطفاً کمی بعد دوباره تلاش
کنید.» · «اکانت تست فقط برای کاربرانی فعال است که قبلاً خرید موفق
نداشته‌اند.» · «برای دریافت اکانت تست، ابتدا در کانال‌های مشخص‌شده عضو
شوید.» · «ظرفیت اکانت تست این لوکیشن تکمیل شده است. لطفاً بعداً تلاش
کنید.»

**Forged/stale callbacks are harmless by construction.** Button
visibility is presentation only: a user replaying an old `user:free_test`
callback (or an old reply-keyboard label) hits the same entry, which
re-checks the global switch first — a globally disabled feature answers
the dedicated «اکانت تست رایگان در حال حاضر غیرفعال است.» (never the
misleading no-panel text) — then re-checks eligibility, panel readiness
(«در حال حاضر پنل فعالی برای ارائه اکانت تست وجود ندارد.» when nothing is
ready), and finally capacity + claim uniqueness inside the atomic
`claimFreeTrial` transaction.

## Remaining limitations

- **Channel-membership check inherits the force-join placeholder**: with
  `free_trial_require_channel_membership` on, a user is treated as
  unverified while `force_join_enabled` is on and they lack
  `forceJoinBypass`. Real `getChatMember` verification is a documented
  later phase repo-wide; this gate hardens automatically when it lands.
- **Manual-review alerts DM OWNER admins directly** — the LogTopic emit
  infrastructure (Telegram log-group topics) is still absent.
- **Centralized RBAC is a separate task** — the OWNER-only gate on the
  admin trial routes is a local copy of the financial-reconciliation
  gate (see `docs/free-trial-security.md`).
- **No automatic remote deletion of expired trials** — expiry marks the
  claim/service `EXPIRED` locally; the remote account is only disabled
  when the panel opts into `testAutoDisableAfterExpiry` (and never
  deleted — `deleteService` is not a supported service operation for
  either panel family).
- Global trial settings are `Setting` rows with code-level fallbacks and
  are not seeded — `free_trial_enabled` stays `false` on fresh AND
  existing installations until an OWNER explicitly enables it from
  «تنظیمات عمومی ⚙️ → تنظیمات اکانت تست 🎁» (see
  `docs/free-trial-admin-management.md`); the other global keys have no
  Telegram page yet.
