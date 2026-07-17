# Free-trial security model

Threat model and hardening for free-trial VPN accounts. Companion to
`docs/free-trial-architecture.md` (design) and
`docs/free-trial-admin-management.md` (operator surface).

The asset being protected is free remote capacity: every trial is a real
account on a real panel, so abuse = unpaid resource consumption. The
guarantees below are enforced in
`apps/bot/src/services/free-trial.service.ts`,
`apps/bot/src/services/free-trial-entitlement.service.ts`,
`apps/bot/src/services/free-trial-admin.service.ts` and the database
schema, and locked by `apps/bot/tests/free-trial.test.ts` and
`apps/bot/tests/trial-lifecycle-entitlements.test.ts` /
`trial-campaigns.test.ts`.

## Anti-abuse

**One live claim per user, DB-enforced.** The partial unique index
`FreeTrialClaim_userId_live_key` (`userId` where status ∈ CLAIMED /
PROVISIONING / ACTIVE / MANUAL_REVIEW) makes the database — not
application reads — the arbiter: N simultaneous confirms yield one insert
and N−1 instant `P2002` denials. Lifetime («once per user», default on)
and cooldown policies are enforced transactionally on top, over `EXPIRED`
rows the index deliberately excludes so policy stays admin-configurable.

**Identity is the internal DB user id — never the Telegram username.**
Eligibility, the unique index and the ownership marker key on `User.id`
(bound to the immutable numeric `telegramId`). A user renaming or
dropping their @username gains nothing; the marker embeds the numeric id
(`zedbot trial:<claim-short> tg:<telegramId>`).

**No IP or device fingerprinting — deliberately.** Telegram bots do not
expose client IPs or device identifiers to bot code, so any such signal
would be fabricated, spoofable, and a privacy liability. The
sybil-resistance anchor is the Telegram account itself (one account = one
entitlement), optionally hardened by the no-previous-purchase and
channel-membership gates. Creating many Telegram accounts remains the
residual abuse vector — bounded per panel by
`testMaxConcurrentAccounts` and operationally by the stats page.

**Capacity race-safety.** Per-panel capacity is decided inside a
transaction under `pg_advisory_xact_lock` on a panel-derived key: the
oldest claims within the limit win and a losing insert cancels itself.
Two users racing the last slot can never both provision (proven by
test 22). Over-allocation is structurally impossible — there is no
count-then-insert window.

**Fail-closed Redis.** If the lock backend is unavailable the claim path
denies BEFORE writing anything (nothing consumed). If lock acquisition
fails after a claim exists but before any remote attempt
(`attemptCount === 0`), the claim is released as `CANCELLED` — the
entitlement is not burned by infrastructure failure. After a first
attempt, an unavailable lock keeps the claim for reconciliation instead
of releasing it (the panel may already hold an account).

**No retry during UNKNOWN.** An uncertain remote outcome leaves the claim
`PROVISIONING`: the user gets «نتیجه ساخت اکانت تست هنوز مشخص نیست و در
حال بررسی است.» with no retry button, and the live-claim index blocks a
new claim anyway. Only reconciliation against the exact frozen username
(+ ownership marker semantics) can settle it — as `APPLIED` (recover the
one account) or `NOT_APPLIED` (release as retryable `FAILED`). Duplicate
accounts from retry-hammering are impossible (tests 24/25).

**Forged panel selection is rejected.** Callback data carries only a
short panel id, and it resolves exclusively over the CURRENT trial-ready
set (`ACTIVE` + `testEnabled` + full config assessment) with a strict
`[0-9a-f-]{4,32}` shape check and unique-prefix match. A crafted callback
naming a paid-only, inactive or misconfigured panel resolves to nothing;
`claimFreeTrial` re-checks `testEnabled` + assessment + eligibility again
server-side, and every quota/duration/expiry value is re-read from the
database — nothing from Telegram input is trusted (proven by the
forged-selection test: denied, zero claims written).

**Eligibility is re-checked at claim time.** The pre-flight
`checkTrialEligibility` (user `ACTIVE`, global switch, live claim, prior
consumption, purchase and membership gates) is advisory rendering; the
claim path re-runs it and the DB guards decide. Blocked users
(`UserStatus !== ACTIVE`) are denied outright.

## Entitlement invariants (trial-entitlement phase)

**Reservation is atomic and overdraw-proof.** One allowance unit is
reserved INSIDE the claim-insert transaction, under the per-user
advisory lock (`zedbot-free-trial-user:<userId>`), via a conditional
`UPDATE … WHERE consumed < allowance` — the row update re-checks the
guard, and the database `CHECK` constraints (`allowance >= 0`,
`consumed >= 0`, `consumed <= allowance`) are the authoritative
backstop. The claim row is the reservation receipt: a rollback releases
everything together, and a retried claim reuses the same reservation.
Twenty concurrent clicks against ONE remaining unit yield one claim, one
consumed unit, one account (suite C).

**Barriers are re-checked inside the claim transaction.** A
revoke/denial/cooldown that lands after the outer eligibility read still
wins: the transaction re-reads the user row before reserving. Concurrent
revoke-vs-claim and reset-vs-claim races converge safely (tests C2/C3).

**Release is exactly-once, and only on positive evidence.** The CAS on
`FreeTrialClaim.allowanceReleasedAt IS NULL` (restricted to
`FAILED`/`CANCELLED` claims) admits at most one release per claim, under
any number of concurrent sweeps. Only positively-established
non-creation releases (pre-remote validation failure, definite remote
failure, reconciled `NOT_APPLIED`, OWNER-forced not-created); UNKNOWN
outcomes never release. A released unit reopens a `CONSUMED` grant but
never resurrects a `REVOKED`/`EXPIRED` one. See
`docs/free-trial-entitlements.md`.

**Admin mutations are idempotent and audited.** Every grant/reset/
set-remaining carries a one-shot `idempotencyKey`
(`trial-grant:` / `trial-reset:` / `trial-setrem:` + nonce; unique in
the DB) — replayed confirmations converge on the one existing row.
Every mutation writes an `AuditLog` row (`writeTrialAudit`) with safe
before/after metadata; grants are capped at 100 per operation and 500
users per interactive bulk selection.

**Forcing an undecided claim requires OWNER + warning + reason.** Force
resolution never invents remote state: "created" runs the reconciler
against the frozen username, "not created" releases the unit exactly
once after the explicit warning that releasing may lead to more than one
provisioned trial.

**Destructive bulk operations require a typed confirmation.** A reset
campaign starts only after the preview, the final warning AND the exact
phrase `RESET TRIAL`; the start is CAS-guarded so replays are no-ops.
Campaign grants are triple-idempotent (recipient unique pair,
entitlement unique pair + idempotency key, CAS status flips) and
cancellation never claws back granted allowance
(`docs/free-trial-campaigns.md`).

**Conversion is exactly-once.** `Service.convertedToPaidAt` is stamped
by a CAS (`… IS NULL`) inside the first verified paid operation's own
transaction; replays, races and reconciliation cannot double-convert,
never restore trial allowance and never enable another trial claim
(`docs/free-trial-lifecycle.md`).

## Secret hygiene

- **No tokens, passwords or subscription links are ever logged.** Log
  lines carry claim/panel/user/service ids, safe machine reason codes and
  truncated error messages only. `FreeTrialClaim.failureReasonCode` is a
  short SAFE English marker (≤ 120 chars), never raw provider payloads.
- **The success message — the only place the subscription link appears —
  goes solely to the account owner** (the claiming chat, or a one-time DM
  to the owner after a reconciliation recovery). Tests assert the message
  contains no panel credentials.
- **User-facing panel labels never leak infrastructure**: the trial list
  renders `testLocation ?? name` + specs — never base URLs, credentials
  or internal ids.
- **Admin surfaces are counter-only**: the trial page and stats page
  render config and counters; manual-review alerts to OWNER admins carry
  the claim short id, status and attempt count — no usernames, links or
  secrets.
- **No secrets in audits or admin history pages**: `AuditLog` metadata
  is safe scalars (counts, dates, reasons, statuses); the per-user
  history page shows claim ids, panel names, statuses, dates and the
  frozen username; the trial-services page shows username/status/expiry/
  converted marker — never subscription URLs, tokens or remote client
  ids; campaign recipient pages show safe skip/error markers only.
- Foreign users can never read a trial service: services are
  owner-scoped everywhere (asserted in tests).

## Permissions

| Surface | Requirement |
| --- | --- |
| User flow (`user:free_test`, `user:ft:p:<sid>`, `user:ft:go:<sid>`) | registered bot user (`ctx.dbUser`), user status `ACTIVE`, feature enabled + panel ready |
| Admin trial page and ALL its subroutes (`admin:panel:trial/tren/trdis/trpn/trst`, legacy `ts`, trial field edits/toggles) | active admin with role **OWNER** — enforced per route by `requireOwner`; non-OWNER admins get a data-free toast «دسترسی به این بخش فقط برای مالک مجموعه فعال است.» |
| Per-user «مدیریت اکانت تست 🎁» (`admin:users:trial:*`) | active admin; **OWNER-only inside**: «تنظیم تعداد تست باقی‌مانده» (set remaining) and every force-resolution/reconcile button — non-OWNERs get «فقط مالک ربات به این بخش دسترسی دارد.» |
| Quota dashboard + campaigns (`admin:trialent:*`, incl. the campaign text flow) | active admin with role **OWNER** — every callback route and the builder's text handler re-check the role |
| Non-admins on admin routes | stopped earlier by the admin auth middleware |

The OWNER gate is a local copy of the financial-reconciliation gate;
**centralized RBAC is a documented separate task**.

## Known gaps (documented, accepted for this phase)

- **Channel-membership verification is inherited from the force-join
  placeholder** — with the membership gate on, users are denied while
  forced-join is enabled and they lack a bypass, but no real
  `getChatMember` call happens yet. The gate hardens automatically when
  the repo-wide force-join verification lands.
- **Manual-review alerting DMs OWNER admins** because the LogTopic
  (log-group topic) emit infrastructure is still absent.
- **Multi-account Telegram abuse** is not (and cannot reliably be)
  detected per device/IP; mitigations are the per-panel capacity cap,
  once-per-user default, optional purchase/membership gates and the
  disabled-by-default posture.
- Expired trials are not deleted remotely; opt-in
  `testAutoDisableAfterExpiry` disables them, otherwise the remote
  account's own quota/expiry enforcement is the backstop.
