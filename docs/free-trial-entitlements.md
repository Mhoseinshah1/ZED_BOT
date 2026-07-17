# Free-trial entitlements — claims, allowances, reservation and release

The trial-entitlement phase separates **permission** from **execution**:
a `FreeTrialEntitlement` is PERMISSION for one or more trial claims; a
`FreeTrialClaim` remains one actual request/provisioning attempt. One
shared eligibility/allowance policy now feeds every trial surface — the
user trial flow, forged-callback re-validation, the per-user admin page,
grant/reset previews and campaign skip rules all consume the same
calculator.

Source of truth:
`apps/bot/src/services/free-trial-entitlement.service.ts` (calculator,
reservation, release, expiry sweep),
`apps/bot/src/services/free-trial.service.ts` (claim-transaction wiring),
`apps/bot/src/services/free-trial-admin.service.ts` (admin mutations),
`packages/database/prisma/schema.prisma` (`FreeTrialEntitlement`,
`FreeTrialClaim.entitlementId`/`allowanceReleasedAt`, `User.freeTrial*`
override columns) and the migration
`packages/database/prisma/migrations/20260717000000_trial_entitlements_and_lifecycle/`.
Tests: `apps/bot/tests/trial-lifecycle-entitlements.test.ts` (suites B
and C).

## Claim vs entitlement

```
FreeTrialEntitlement (permission: allowance N, consumed M)
        ▲  entitlementId (which row funded the claim; NULL = default pool)
        │
FreeTrialClaim (one attempt) ──provisions──► remote account + Service
```

- Entitlement rows exist **only** for admin grants, resets, campaign
  grants, compensations and migrations (`FreeTrialEntitlementSource`:
  `DEFAULT_POLICY` / `ADMIN_GRANT` / `ADMIN_RESET` / `CAMPAIGN_RESET` /
  `COMPENSATION` / `MIGRATION`). The **default policy allowance is
  virtual — never materialized as rows**.
- Scope is `GLOBAL` or `PANEL` (`panelId` set): a panel-scoped grant
  counts only toward claims on that panel; the panel-agnostic overview
  still lists its remaining units.
- Optional `startsAt`/`expiresAt` window; `reason` is the mandatory
  admin-provided justification (internal — never shown to the user);
  `idempotencyKey` is unique (see release/idempotency below).
- Status: `ACTIVE` → `CONSUMED` (when `consumed` reaches `allowance`) /
  `EXPIRED` (window passed) / `REVOKED` (admin). **Rows are never
  deleted**: expired/revoked remainders become unusable but the history
  and the claims they funded stay linked.

## Default allowance semantics (legacy mapping)

`effectiveDefaultAllowance(user)` resolves the user's DEFAULT pool size
in strict precedence order:

1. **Per-user override** — `User.freeTrialDefaultAllowanceOverride`
   (set by the OWNER "set remaining" operation) wins when non-null
   (clamped to ≥ 0).
2. **Global setting** — `free_trial_default_allowance`
   (`FREE_TRIAL_DEFAULT_ALLOWANCE_KEY`), a non-negative integer when set
   to a non-empty value.
3. **Legacy semantics, preserved exactly** — with the setting unset/empty:
   `free_trial_once_per_user` on → allowance **1**; off → **unlimited**
   (`null`), with repeats gated only by the cooldown setting.

The default pool's consumption is **derived, not stored**: it is the
count of the user's claims with `entitlementId NULL` in a consuming
status. `CONSUMING_CLAIM_STATUSES` = `CLAIMED`, `PROVISIONING`, `ACTIVE`,
`MANUAL_REVIEW`, `EXPIRED` — i.e. in-flight, live and used trials count;
`FAILED`/`CANCELLED` never do.

**Backfill policy: NONE, by design.** Historical claims keep
`entitlementId NULL`, so the calculator counts them as consumed DEFAULT
units — existing one-trial semantics survive the migration without fake
admin grants, new eligibility or evidence-less conversions.

## Deterministic consumption order

When a claim needs a unit, usable entitlements
(`ACTIVE`, inside their window, `consumed < allowance`, scope matching
the target panel) are ordered by `orderEntitlementsForConsumption`:

1. **matching panel-specific grant**, nearest expiration first;
2. **global admin grant** (`ADMIN_GRANT`/`ADMIN_RESET`/`COMPENSATION`/
   `MIGRATION`), nearest expiration first;
3. **campaign entitlement** (`CAMPAIGN_RESET`), nearest expiration first;
4. **default policy allowance** (virtual — consulted only when no row
   yields a unit).

Ties break by `createdAt` then `id`, so a retried reservation picks the
same row deterministically.

## The one eligibility calculator

`computeTrialEligibility(user, { panelId? })` returns a
`TrialEligibilityResult` (`eligible`, `remainingClaims`,
`unlimitedDefault`, `activeClaimExists`, `cooldownEndsAt?`,
`entitlementIds`, `denialReason?`, `denialText?`). The check order
preserves the historical engine's semantics with the admin barriers and
the allowance model layered in:

user state → admin revoke → admin temporary denial → live claim →
active trial → global switch → admin cooldown → setting cooldown →
previous-purchase policy → membership policy → allowance.

The **ten denial reasons** and their user-facing Persian texts
(constants in `free-trial-entitlement.service.ts`, verbatim):

| `denialReason` | Trigger | Persian text |
| --- | --- | --- |
| `USER_BLOCKED` | `User.status !== ACTIVE` | «در حال حاضر امکان دریافت اکانت تست برای حساب شما فعال نیست.» |
| `ADMIN_DENIED` | `freeTrialRevokedAt` set | «در حال حاضر امکان دریافت اکانت تست برای حساب شما فعال نیست.» |
| `ADMIN_DENIED` | `freeTrialDeniedUntil` in the future | «دسترسی شما به اکانت تست تا تاریخ {تاریخ} غیرفعال است.» (`trialDeniedUntilText`) |
| `ACTIVE_CLAIM` | live claim (`CLAIMED`/`PROVISIONING`/`MANUAL_REVIEW`) | «یک درخواست اکانت تست برای شما در حال پردازش یا بررسی است.» |
| `ACTIVE_CLAIM` | an `ACTIVE` (unexpired) trial exists | «شما قبلاً از اکانت تست رایگان استفاده کرده‌اید.» |
| `GLOBAL_DISABLED` | switch off, allowance remains | «شما سهمیه تست دارید، اما اکانت تست در حال حاضر به‌صورت سراسری غیرفعال است.» |
| `GLOBAL_DISABLED` | switch off, no allowance | «اکانت تست رایگان در حال حاضر غیرفعال است.» |
| `COOLDOWN` | admin `freeTrialCooldownUntil` or the setting-computed cooldown off the most recent consuming claim (unless waived by `freeTrialCooldownClearedAt`) | «امکان دریافت تست بعدی از تاریخ {تاریخ} فعال می‌شود.» (`trialCooldownText`) |
| `PREVIOUS_PURCHASE` | policy on + `paidOrdersCount > 0` | «اکانت تست فقط برای کاربرانی فعال است که قبلاً خرید موفق نداشته‌اند.» |
| `MEMBERSHIP_REQUIRED` | policy on + force-join gate unpassed | «برای دریافت اکانت تست، ابتدا در کانال‌های مشخص‌شده عضو شوید.» |
| `PANEL_NOT_ALLOWED` | zero remaining for THIS panel while remaining exists elsewhere (panel-scoped grants) | «سهمیه تست شما برای این لوکیشن قابل استفاده نیست.» |
| `ENTITLEMENT_EXPIRED` | zero remaining and an expired grant with unused units exists | «اعتبار سهمیه اکانت تست شما به پایان رسیده است.» |
| `NO_ALLOWANCE` | plain exhaustion | «سهمیه اکانت تست شما به پایان رسیده است.» |

Dates render via `formatPersianDate` (fa-IR short date+time with an ISO
fallback). The legacy engine dialect survives:
`checkTrialEligibility` adapts the result to `{ok, code, text}` with the
historical machine codes (`no-allowance`, `cooldown`, `admin-denied`,
`trial-active`, …) for logs and tests.

**The calculator alone is never trusted for the claim** — it is advisory
rendering. The claim-insert transaction re-runs the barrier checks on a
fresh user row and makes the reservation itself.

## Atomic reservation (inside the claim transaction)

`insertClaim` (in `free-trial.service.ts`) is insert-first: the partial
unique live-claim index kills concurrent same-user claims instantly,
then — in the **same transaction**:

1. re-reads the user row and re-checks the admin barriers (a
   revoke/denial/cooldown that landed after the outer eligibility read
   wins over the claim);
2. calls `reserveTrialAllowance(tx, freshUser, panelId,
   { excludeClaimId })`, which:
   - takes the per-user advisory lock
     `pg_advisory_xact_lock(hashtext('zedbot-free-trial-user:<userId>'))`;
   - walks the usable entitlements in the deterministic order and
     attempts a **conditional raw UPDATE** per candidate:
     `SET consumed = consumed + 1` (flipping `status` to `CONSUMED` when
     full) `WHERE status = 'ACTIVE' AND consumed < allowance AND` the
     window still holds — the row update itself re-checks the guard, so
     a concurrent transaction **cannot overdraw**;
   - falls back to the virtual default pool: counts `entitlementId NULL`
     consuming claims (excluding the claim being funded RIGHT NOW) under
     the advisory lock and admits the claim while
     `consumed < defaultAllowance` (unlimited default always admits);
   - otherwise refuses with `NO_ALLOWANCE`;
3. stamps the winning `entitlementId` on the claim (NULL for the default
   pool). **The claim row is the reservation receipt** — a transaction
   rollback releases the claim and the increment together, and a retry
   reuses the claim and therefore the same reservation.

The database `CHECK` constraints (`allowance >= 0`, `consumed >= 0`,
`consumed <= allowance`) plus the conditional UPDATE are the
authoritative overdraw guards (see `docs/database-invariants.md`).

Per-panel capacity is decided AFTER the insert as before; a claim that
loses the capacity race cancels itself and **returns its reserved unit**
(below).

## Exactly-once release

`releaseClaimAllowance(claimId, reason)` returns the claim's unit at
most once, via a CAS transaction:

1. stamp `allowanceReleasedAt` `WHERE allowanceReleasedAt IS NULL AND
   status IN (FAILED, CANCELLED)` — losers (already released, or the
   claim is not in a released state) return `false` and change nothing;
2. only for entitlement-funded claims: `consumed = consumed - 1
   WHERE consumed > 0`, reopening a `CONSUMED` row to `ACTIVE` — but
   **never resurrecting a `REVOKED` or `EXPIRED` row** (their remaining
   stays unusable; the decrement still records the return).

Release is permitted **only on positively established non-creation**.
The complete rule set, by remote outcome:

| Outcome | Who decides | Allowance |
| --- | --- | --- |
| DEFINITELY NOT CREATED — validation failed before any remote call (`naming-failed`), lock backend unavailable on attempt 0 (`lock-unavailable`), stale `CLAIMED` row (`stale-claim`), capacity race lost (`capacity-full`), definite remote create failure (`remote-create-failed`) | claim path / sweep via `cancelClaimSafely` or the FAILED CAS | **released** (exactly once) |
| `NOT_APPLIED` — reconciliation positively established absence on the panel (`reconciled-not-applied`) | `reconcileTrialClaim` | **released** (exactly once) |
| forced not-created (`forced-not-created`) | OWNER force resolution, after the mandated warning | **released** (exactly once) |
| CREATED AND VERIFIED — provisioned or recovered (`APPLIED`) | claim path / reconciler | **stays consumed** |
| UNKNOWN — uncertain remote outcome | nobody | **never released**; the claim stays `PROVISIONING`/`MANUAL_REVIEW` until reconciliation or an OWNER decides |

The CAS makes every path idempotent under concurrent sweeps: a release
raced by another release decrements exactly once (locked by suite C
tests C4–C6).

## Per-user admin barriers

Additive nullable `User` columns, all enforced by the calculator AND
re-checked inside the claim transaction:

| Column | Set by | Effect |
| --- | --- | --- |
| `freeTrialRevokedAt` (+ `freeTrialRevokedByAdminId`) | «لغو دسترسی تست» | blocks all FUTURE claims (`ADMIN_DENIED`); history/services untouched |
| `freeTrialDeniedUntil` | «مسدودسازی موقت تست» | temporary denial until the date (distinct message from cooldown) |
| `freeTrialCooldownUntil` | «تنظیم محدودیت زمانی» | hard cooldown barrier until the date |
| `freeTrialCooldownClearedAt` | «رفع محدودیت زمانی» / reset | waives the setting-computed cooldown for claims older than the waiver |
| `freeTrialDefaultAllowanceOverride` | OWNER set-remaining | pins the DEFAULT pool size for this user (0 = default pool closed) |

Reset («ریست دسترسی تست») clears the first four barriers, stamps the
cooldown waiver and grants a fresh `ADMIN_RESET` entitlement — it never
deletes claims, services or conversions, and it is refused with
«برای این کاربر یک درخواست تست در حال پردازش یا بررسی است. ابتدا وضعیت
آن را مشخص کنید.» while a live/manual-review claim exists (force
resolution must decide the pending claim first). See
`docs/free-trial-admin-management.md` for the full admin surface.

## Entitlement expiry

`expireTrialEntitlements` (step 0 of the trial sweep,
`runFreeTrialSweep`) deterministically flips `ACTIVE` rows past their
`expiresAt` to `EXPIRED` — idempotent, never deletes, unused units
become unusable and produce the `ENTITLEMENT_EXPIRED` denial instead of
the generic exhaustion text. The calculator also treats an in-window
check of `ACTIVE` rows with a passed `expiresAt` as unusable, so
eligibility is correct even between sweep ticks.
