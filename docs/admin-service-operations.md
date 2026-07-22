# Admin Service Operations

An audited, failure-safe per-Service admin console. It upgrades the read-only
«مدیریت کاربران → سرویس‌های کاربر» surface into a place where the **bot OWNER**
can inspect one service and — when explicitly enabled — perform a small,
tightly-gated set of lifecycle operations on it: enable/disable, grant volume,
grant time, regenerate the subscription link, and record an internal note.

It is built entirely on the existing lifecycle primitives — the per-service
distributed lock, the PanelAdapter capability model, the panel-readiness gates,
the service sync primitive, the enable/disable + link-regeneration services, the
pure entitlement calculators, and the normalized panel results. It never
introduces a second lifecycle implementation, and it **never** moves money or
fabricates financial history.

## Rollout & safety switch (§3)

- Setting `admin_service_mutations_enabled` (default **false**).
- Read-only **detail** and read-only **refresh** are always available to any
  authenticated admin and do **not** depend on the switch.
- Every lifecycle-mutation button is hidden while the switch is off; a stale or
  hand-crafted mutation callback **fails closed** (`MUTATIONS_DISABLED`).
- Only the **OWNER** may flip the switch (atomic compare-and-set) and only the
  OWNER may perform lifecycle mutations. Every callback re-validates the OWNER
  role and the switch inside the executor — never trusting the button alone.

Reach the switch from **تنظیمات عمومی → عملیات سرویس (ادمین) ⚙️**.

## Data model (§5)

`AdminServiceOperation` is a purely additive audit/reconciliation table. Every
relation (`serviceId`, `targetUserId`, `adminId`) is `SET NULL` so history
survives the deletion of a service, user or admin. Key columns:

- `type` (`ENABLE`/`DISABLE`/`ADD_VOLUME`/`ADD_TIME`/`REGENERATE_LINK`/`ADD_NOTE`)
  and `status` (`PENDING`/`SUCCEEDED`/`FAILED`/`UNCERTAIN`/
  `RECONCILIATION_REQUIRED`/`RECONCILED`/`CANCELLED`).
- `reason` (mandatory for a mutation; the note body for `ADD_NOTE`).
- `requestedValue` + `requestedUnit` — the amount granted, in `GIB`/`DAY`.
- `idempotencyKey` (unique) and `sourceUpdateId` (unique) — double-confirm and
  Telegram-replay convergence.
- `beforeSnapshot` / `afterSnapshot` — **secret-free** state snapshots (see
  below), the durable evidence a reconciliation classifies against.

The operation row — not any log line — is the durable audit and reconciliation
authority.

## Safe state snapshot (§4, §21)

`AdminServiceStateSnapshot` captures only: `status`, `panelStatus`, `panelType`,
`volumeBytes`, `usedBytes`, `remainingBytes`, `expiresAt`,
`lastSubscriptionUpdateAt`. It **never** contains a subscription URL, config
link, QR, panel URL, panel credentials, subscription token, remote client id or
a raw panel response. The stale-preview **fingerprint** hashes only the
decision-relevant fields (`status | panelStatus | panelType | volumeBytes |
expiresAt`) so a background sync that only refreshes usage counters never
produces a false "stale preview".

## The executor (§10, §11)

`executeAdminServiceOperation` is the single lifecycle-mutation authority. Its
sequence, for every mutation:

1. revalidate the **OWNER** against the live admin row;
2. recheck the **mutation master switch**;
3. idempotency fast-path (converge a repeated confirm by `idempotencyKey`, and a
   Telegram replay by `sourceUpdateId`);
4. acquire the **per-service lock** (Redis unavailable → fail closed, no panel
   call, no row);
5. reload Service + Panel under the lock;
6. eligibility + capability gates (remote-model global-client, panel ACTIVE,
   adapter supports the op, status eligible, value in range);
7. conflicting-operation guard (an unresolved `PENDING`/`UNCERTAIN`/
   `RECONCILIATION_REQUIRED` op on the same service blocks a new mutation);
8. **fingerprint compare** (stale preview → fail closed);
9. `PENDING` claim (the durable row; a concurrent double-execute converges via
   the unique `idempotencyKey`);
10. **one** remote mutation;
11. classify **definite success / definite failure / UNCERTAIN**;
12. persist the local Service row **only on definite success**;
13. persist the operation status + `afterSnapshot`;
14. release the lock; notify the user **once** after a real change; re-render.

**UNCERTAIN never auto-retries.** An unknown outcome blocks conflicting
mutations and is resolved only by the read-only reconciliation page. This is
mandatory for `ADD_VOLUME`/`ADD_TIME` to prevent a double-grant.

### Verify-after-write for grants (§11)

Some adapters (Marzban's `addServiceTime`/renew) do not flag an ambiguous
modify-timeout as `uncertain`. So on a non-`ok`, non-`uncertain` grant result
the applier performs one **read-only verification**: if the panel now shows the
target applied, the op becomes `RECONCILIATION_REQUIRED` (never re-issued); if
it positively shows the pre-state, the op is a definite `FAILED`; anything
ambiguous is `UNCERTAIN`. A possibly-applied grant is therefore **never** marked
`FAILED` (which would invite a retry and double-grant).

## Actor-aware primitives (§12)

Enable/disable and link-regeneration reuse the existing user-facing services
through exported lock-free bodies (`toggleServiceStatusUnlocked`,
`regenerateServiceSubscriptionUnlocked`) that take an **actor**. A USER actor
keeps the existing events and messages unchanged; an ADMIN actor audits the
action under a distinct `SERVICE_*_BY_ADMIN` event correlated to the operation
id — **never** as `..._BY_USER`. The user-facing wrappers and their tests are
untouched.

## Volume & time grants (§14, §16)

Complimentary grants reuse the low-level panel mutation and the pure calculator,
but **never dispatch a paid Order** and never touch any financial table.

- **Volume**: presets 1/5/10/20/50 GiB or a custom 1..10000; binary GiB, checked
  BigInt. A fresh panel read establishes the current total; the new total is
  `current + granted`, applied via the reset-free `addServiceTime` mechanism
  with the expiry passed through unchanged. **Used bytes are preserved and
  traffic is never reset**; total and remaining rise equally. Unlimited/unknown
  quota is blocked.
- **Time**: presets 1/3/7/15/30 days or a custom 1..3650. A future expiry
  extends from the current expiry; a past/expired one extends from now. Quota is
  unchanged and usage is never reset. Never-expiring/unknown-expiry is blocked.

Volume/time grants are **not** offered on a `DISABLED` service (the
`addServiceTime` mechanism sets the panel status active; a disabled service must
be enabled first). Extending an `EXPIRED` service via time is the intended
revival.

## No fake financial history (§6)

An admin grant records a distinct `EXTRA_VOLUME_GRANTED_BY_ADMIN` /
`EXTRA_TIME_GRANTED_BY_ADMIN` `ServiceEventLog` event with **no** `orderId`, and
creates/modifies **no** `CheckoutSession`, `Payment`, `Order`,
`WalletTransaction`, `DiscountCodeUsage`, referral commission, sales total,
paid-order counter or revenue figure. A trial service is never converted to paid
by a free admin grant. Regression tests assert every financial table and the
user's balance/counters are unchanged across a batch of operations.

## Internal notes (§17)

Any OWNER may attach a note (no panel call, no lock, independent of the mutation
switch). Notes are 1..1000 chars, stored verbatim and rendered HTML-escaped,
immutable, and never logged. The composer shows the warning **«اطلاعات کانفیگ،
لینک اشتراک، رمز یا توکن را در یادداشت وارد نکنید.»**

## Read-only refresh (§9)

`admin:svc:refresh:<sid>` reuses the shared read-and-sync primitive: at most one
authenticated panel read under the per-service lock, never a remote mutation,
never an operation row. It distinguishes a positive **not-found** from a
timeout/auth/unreachable failure and works while mutations are disabled.

## Reconciliation (§18)

The OWNER-only dashboard **«عملیات سرویس نیازمند بررسی ⚠️»** lists every
`UNCERTAIN` / `RECONCILIATION_REQUIRED` operation. Running a reconcile performs
one fresh read, classifies the operation against its stored target, and — only
with positive evidence — marks it `RECONCILED` (syncing the local row from panel
truth) or `FAILED`. It never repeats the remote mutation and never writes
anything the read did not establish; an inconclusive read leaves the operation
for a later attempt. A link regeneration cannot be verified by a read and always
stays for manual review.

## Notifications (§19)

After a lifecycle change succeeds, the service owner is notified **once** (CAS on
`userNotifiedAt`). The message contains no secret, no reason and no admin
identity — only that the service was updated — plus a button to the customer's
own service detail.

## Callbacks & privacy (§20, §21, §24)

Every callback payload is ≤64 bytes and carries only an 8-char short id (an
opaque id prefix, never a secret). Audit/ops logs carry only DB ids, the
operation type/status, a coarse requested-value **bucket** (never the exact
amount), the panel type and a safe error code — never a URL, config, QR, panel
credential, token, raw response, thrown error, note or reason.

## Explicitly out of scope (§27)

No subtract-volume/time, no traffic reset, no username change, no ownership
transfer, no panel migration, no service deletion, no auto-retry of an uncertain
operation, and no exposure of a subscription URL/token to the admin surface.

## Testing (§26)

`apps/bot/tests/admin-service-operations.test.ts` runs against real PostgreSQL +
Redis and a faithful mock Marzban panel, covering: preserve-used volume grants,
time extension + expired-revival, enable/disable actor auditing, link regen with
no link in the log, the financial-isolation batch proof, the rollout gates
(disabled / non-OWNER), stale-preview rejection, idempotent convergence,
eligibility blocks (unlimited / never-expiring / disabled), immutable idempotent
notes with no panel/financial effect, read-only refresh (sync / not-found /
works-while-disabled), the landed-but-errored → `RECONCILIATION_REQUIRED` path
with the conflicting-op block and a reconcile that resolves it, and a definite
modify failure → `FAILED`.
