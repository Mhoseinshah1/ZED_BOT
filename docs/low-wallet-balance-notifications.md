# Low wallet balance notifications

Tell a user their wallet is running out — once per genuine decrease, never twice
for the same one, never after they have topped up, and never as a side effect of
shipping or enabling the feature.

Everything below is disabled by default. Deploying this code notifies nobody.

---

## 1. The canonical money unit

Wallet money in this repository is **whole Toman**, stored in
`User.balanceToman`: a Prisma `Int`, which is a PostgreSQL `INTEGER` — 32-bit,
range ±2,147,483,647.

In code it is a plain integral JavaScript `number`. **BigInt and Decimal are
deliberately not used here.** Introducing a second representation of the same
money would be a second source of truth for a value that already has one, which
is exactly what the requirement "do not create a second independent wallet
balance source" forbids. INT32 is far inside `Number.MAX_SAFE_INTEGER`
(2^53 − 1), so integer arithmetic on these amounts is exact — there is no
floating-point money anywhere in this feature.

Traffic volumes elsewhere in the codebase *are* `BigInt` (`volumeBytes`,
`usedBytes`), because bytes genuinely exceed INT32. Money does not.

Display formatting is centralised in `formatTomanAmount()`
(`packages/shared/src/low-balance.ts`), which renders `90000` as
`90,000 تومان`. A user is never shown a raw integer where a Toman amount
belongs.

---

## 2. Configuration

| Setting key | Default | Meaning |
| --- | --- | --- |
| `low_balance_notification_enabled` | `false` | Master switch |
| `low_balance_threshold` | `100000` | Alert at or below this (Toman) |
| `low_balance_rearm_margin` | `20000` | Hysteresis band above the threshold |
| `low_balance_config_version` | `1` | Bumped whenever a boundary changes |
| `low_balance_reconcile_minutes` | `15` | Repair-sweep cadence |

Derived boundaries:

```
alert boundary  = threshold
re-arm boundary = threshold + rearm margin
```

A **zero margin is legal**, and means the machine re-arms as soon as the balance
is *strictly* above the threshold. It is the noisiest setting, not an invalid
one: a balance hovering exactly on the boundary will alert on every crossing.
The default margin exists to prevent that.

Changing either boundary bumps `low_balance_config_version` and is rejected if
the resulting re-arm boundary would exceed the INT32 range of `balanceToman` —
a boundary no balance can ever reach would leave every alerted user permanently
stuck ALERTED, unable to re-arm.

**Every configuration mutation is one serialized transaction.** The boundary and
its version are two `Setting` rows that only mean something together: a version
that did not move leaves alerts queued under the old boundary indistinguishable
from alerts queued under the new one. Written as two independent statements this
had two failure modes — a database error between them commits a new boundary
under an old version, and two concurrent admins can interleave read-read-write-
write and lose an increment entirely.

So each mutation takes `pg_advisory_xact_lock(hashtext('zedbot-low-balance-config'))`
first, re-reads the configuration from the Setting **rows** (never the 30-second
process cache, which is per-process and can be stale), validates the threshold and
the margin against that one locked snapshot, and writes the changed boundary and
the incremented version together. The process cache is dropped only *after* the
commit — seeding it inside would advertise a value a rollback could take away.

A row lock cannot do this job: the version row may not exist yet, and
`SELECT … FOR UPDATE` over an absent row locks nothing. The advisory lock exists
independently of any row and is released at COMMIT or ROLLBACK. It is its own
namespace, so it never blocks — or is blocked by — the terms or force-join
configuration locks that use the same convention.

Creating a backfill run takes the same lock and reads the same rows, so the
configuration it freezes is one coherent `(threshold, margin, version)` tuple
rather than four independent cached reads that could straddle a change.

---

## 3. The state machine

One durable row per user, `LowBalanceAlertState`:

```
ARMED   --(committed balance <= threshold)-->   ALERTED   (notify once)
ALERTED --(committed balance >  boundary)-->    ARMED     (silently)
```

### Three kinds of cycle

These look alike and mean different things:

| | Meaning | Message? |
| --- | --- | --- |
| **cycle 0 — silent baseline** | "Already below the threshold the first time we ever looked." Recorded ALERTED so the machine is truthful, but no decrease was *witnessed*, so claiming one would be a lie. This is what enabling the feature produces for existing low-balance users. | No |
| **cycle > 0 — real alert** | A witnessed crossing: above the threshold, then at or below it. | Yes, exactly one |
| **cycle > 0 — explicit backfill** | The OWNER asked us to notify people who are already low. Same shape and same dedupe key as a real alert, but opened without a witnessed crossing — which is why it takes an explicit confirmed action. | Yes, exactly one |

`alertCycle` increments on every ARMED → ALERTED transition and is the identity
of "this particular episode of being low". It is what makes the alert
idempotent: the dedupe key is

```
wallet-low-balance:v<ruleVersion>:<userId>:<alertCycle>
```

Re-arming does **not** increment the cycle. Only opening a new alert does.

### First observation, and why the BEFORE balance is required

A user can have no state row at all — the feature was enabled and the sweep has
not reached them. Their next purchase taking them from comfortably funded to
below the threshold is the single most likely real crossing there is, and with
only the *after* balance it is indistinguishable from a user who was always low.
The alert would be silently swallowed. So callers pass both:

| before | after | result |
| --- | --- | --- |
| > threshold | ≤ threshold | cycle 1, ALERTED, **notify** |
| ≤ threshold | ≤ threshold | cycle 0, ALERTED, silent baseline |
| any | > threshold | cycle 0, ARMED, silent |

This asks nothing new of the callers: every wallet site already computes the
before value for its `WalletTransaction.balanceBeforeToman`.

The implementation does not special-case any of this. It **seeds the row from
the before balance and then evaluates the transition to the after balance**, so
a first observation runs through exactly the same code as every later one.

### Concurrent state creation

A row that does not exist cannot be locked. Selecting `FOR UPDATE`, finding
nothing and plain-creating means two first observations both `INSERT`, and the
loser's unique violation aborts the surrounding PostgreSQL transaction — a real
wallet mutation lost to a notification bookkeeping row.

So the row is seeded with `INSERT … ON CONFLICT DO NOTHING` **first** and only
then locked `FOR UPDATE`. Both racers converge on the same row; the second
evaluates against the first's committed result.

### One mechanism, three callers

The live observer, the reconciliation sweep and the backfill all go through
`applyLowBalanceObservation` in `@zedbot/database` — the only package both apps
depend on that has Prisma. It takes a `buildNotification(cycle)` callback so
`@zedbot/shared` stays out of that package. There is deliberately no second
implementation of "when do we alert" to drift.

**Authoritative balance.** When the caller witnessed the edge itself (a wallet
mutation, inside the transaction that moved the money) its `after` is
authoritative by construction. When it did not — the sweep and the backfill pass
a null `before` — the balance is re-read *under the state lock*. Reading it
earlier and deciding later is a real race: a wallet mutation committing in
between makes the sweep judge a stale balance against fresh state, re-arming a
user who has just alerted so the next pass opens a second cycle for the same
decrease.

---

## 4. Where the alert is produced

At the **canonical wallet mutation point**, inside the caller's transaction.

Every wallet-moving service in this repository shares one shape: an atomic
conditional `updateMany` on the locked user row, a read-back of the exact
`balanceAfter`, then a `WalletTransaction` ledger row. Immediately after that
ledger row, each site calls:

```ts
await onWalletBalanceChanged(tx, {
  userId,
  balanceBeforeToman: balanceBefore,
  balanceAfterToman: balanceAfter,
  source: "ORDER",
});
```

Seven call sites across six services:

| Service | Source label |
| --- | --- |
| `wallet-payment` | `ORDER` |
| `gateway-payment` | `GATEWAY_TOPUP` |
| `receipt-review` | `RECEIPT_TOPUP` |
| `provisioning` (refund) | `REFUND` |
| `admin-user-wallet` | `ADMIN_ADJUSTMENT` |
| `referral-commission` (×2) | `REFERRAL` |

The observer takes `SELECT … FOR UPDATE` on the state row, so two concurrent
debits that both cross the threshold serialise: the first opens the cycle, the
second sees ALERTED and does nothing.

It reads configuration from the `Setting` **rows via `tx`**, not from the
process cache, so a wallet mutation cannot act on a configuration the database
has already moved past.

Two rules govern every line of the observer:

1. **It never touches money.** It reads `balanceToman` and records what it
   observed. It never writes a balance, a ledger row or a total.
2. **It never talks to Telegram.** It writes rows only. Delivery happens later,
   in the worker, so a Telegram outage can never roll back a checkout.

---

## 5. Delivery

`AutomatedNotification` **is** the outbox. It already carries a unique
`dedupeKey`, a status lifecycle, retry counters and crash-safe re-claim, so
there is no parallel direct-send subsystem — and the notification commits or
rolls back atomically with the state transition that justified it.

The insert uses `createMany({ skipDuplicates: true })`, which compiles to
`INSERT … ON CONFLICT DO NOTHING`. This is not a stylistic choice:

> A raised unique violation (23505) inside a financial transaction would put
> PostgreSQL into an aborted-transaction state. The caller's next statement
> would fail with 25P02 and `COMMIT` would degrade to `ROLLBACK` — the checkout
> would die because of a duplicate notification. The duplicate must therefore be
> absorbed by the index, never by a caught error.

### The atomicity invariant

**A committed cycle greater than zero always has its deterministic outbox row.**

State transition and outbox insert happen in one transaction — in the wallet
path the caller's, in the sweep and backfill one transaction per user, which
also covers the live balance re-read and the locked state read. Counters and the
cursor commit after the units they describe.

If those were separate commits, a crash in between would leave a user ALERTED
with nothing queued, and every later pass would skip them as "already alerted" —
silent forever.

### What the hook's `catch` does and does not buy

`onWalletBalanceChanged` never throws. Precisely:

* A **logic** error (a `TypeError`, a bad assumption) is swallowed. The money has
  already moved correctly and the reconciliation sweep repairs the state this
  call failed to record, so the mutation stands. Test **L32** proves this.
* A **database** error is *not* recoverable by catching. PostgreSQL marks the
  whole transaction aborted, so the financial mutation rolls back anyway. That
  is safe — money and notification move together or not at all — but it is not
  the same guarantee, and test **L32b** pins it so the claim stays honest.

---

## 6. Send-time policy

A queued alert is valid for **exactly one state cycle** — the one that created
it. Checking only the balance is not enough, because this sequence makes every
balance claim in a stale message true:

1. cycle 1 is queued;
2. the user tops up and the machine re-arms;
3. the user crosses again and cycle 2 opens and is queued;
4. cycle 1 is finally delivered while the balance happens to be low.

Sending both is two warnings for one episode. So delivery proceeds only when
**all** of these hold:

* the feature is enabled;
* the user exists, is ACTIVE, and has not opted out;
* the durable state is `ALERTED`;
* the durable state's `alertCycle` **equals** the notification's;
* the balance has not recovered above that cycle's snapshot boundary.

Cancellation reasons, using the repository's existing short scrubbed markers:

| Situation | Reason | State change |
| --- | --- | --- |
| Durable cycle is newer | `cycle-superseded` | **None.** Re-arming here would close the newer cycle and swallow the message it is waiting to send. |
| State is ARMED on the same cycle | `cycle-closed` | None |
| No state row at all | `state-missing` | None — delivery never invents state |
| Recovered on the matching cycle | `balance-recovered` | Re-arm, scoped to that cycle |
| Feature off / user gone / inactive / opted out | `low-balance-disabled`, `user-gone`, `user-inactive`, `low-balance-opted-out` | None |

**One snapshot.** The state and the balance are read inside a single
transaction with the state row held `FOR UPDATE`. Reading them independently is
how an earlier version could re-arm against a state that no longer matched the
balance it had judged.

**Threshold-change policy.** The recovery test uses the re-arm boundary the
cycle was *opened* under, carried in the notification snapshot — not whatever
the OWNER has configured since. Raising the threshold must not retroactively
resurrect a historical alert; lowering it must not silently cancel alerts that
were correct when they were created.

When it cancels for recovery it also **re-arms** the machine, scoped to the
alert's own cycle. Leaving it ALERTED would swallow the next genuine crossing;
scoping to the cycle stops a stale alert from re-arming a machine that has
already moved on (test **L65**).

---

## 7. The message

Template key `low_balance_notification_text`, category `PAYMENT`, with exactly
two placeholders:

* `{balance}` — the user's current balance
* `{threshold}` — the operator's configured alert boundary

Both arrive **pre-formatted** in the snapshot, so the rendering worker performs
plain substitution.

All three producers — the observer, the repair sweep and the backfill — build
the payload through one shared function, `buildLowBalanceSnapshot()`, so an
alert is byte-identical regardless of which of them opened the cycle
(test **L39**).

**Privacy.** The snapshot carries those two figures plus non-rendered
diagnostics (`alertCycle`, `configVersion`, boundaries, `origin`). It never
holds a name, username, phone number, chat id, ledger id or payment token, so a
snapshot that leaks into a log identifies nobody (test **L37**).

Two buttons, routed by **constant** action codes so relabelling them in the text
registry can never change where they go, and neither charges anything:

| Label key | Action code | Destination |
| --- | --- | --- |
| `low_balance_topup` | `t` | Wallet screen (top-up) |
| `low_balance_view_wallet` | `w` | Wallet screen |

---

## 8. Reconciliation — a repair mechanism, not the trigger

The event-driven observer is authoritative. The sweep
(`RECONCILE_LOW_BALANCE_STATE`, every 15 minutes by default) exists only for the
gaps it cannot cover: rows written before the feature shipped, a legacy path
that bypasses the observer, and the failure modes where the observer's own write
was lost.

**Scale.** It never scans `User` for repairs. Two phases, paged differently on
purpose:

* **Initialise** — users with no state row. This predicate *shrinks* as the
  phase works, so it needs no cursor; each batch takes the next page of whatever
  is still missing. That also makes it self-healing. Paging a shrinking set by
  keyset is subtly wrong: a row whose unit fails sits behind an
  already-advanced cursor and is never revisited. It cost exactly one user in
  several hundred in testing — invisible in production, and permanently
  un-warned.
* **Repair** — every state row. This set does *not* shrink, so it pages by
  keyset (500 rows, at most 20 batches per pass) and **persists its cursor after
  every committed batch**. Without that, a large installation rescans the first
  page forever and its later rows are never repaired. Draining both phases wraps
  the cursor back to the start, so a clean tail cannot pin it there.

**Multi-replica safety — a durable lease, not an advisory lock.** The first cut
used `pg_try_advisory_lock`. A *session-level* advisory lock taken through
Prisma's connection pool is unsafe: the lock and its unlock can be issued on
different pooled connections, so the unlock may target a session that does not
hold it, or the lock may leak until the connection is recycled. Nothing in the
pool guarantees affinity.

It is now a lease row carrying an owner token and an expiry. Acquisition is a
conditional `updateMany` that admits only an unheld or expired lease, so of N
replicas exactly one wins and the rest return immediately. Every write the
holder makes is guarded on still holding the token. A crashed worker cannot
strand the sweep, because its lease simply expires and is taken over. The
backfill run carries the same claim, so two replicas cannot advance it at once.

This mirrors the claim convention the notification maintenance worker already
uses — conditional `updateMany` plus a bounded-age takeover — rather than
introducing a second coordination framework.

**Safety.** It advances the machine exactly like the observer does, through the
same dedupe key, so it cannot produce a second message for a cycle that already
has one. A user it initialises for the first time who is *already* low is
recorded ALERTED **without** a message.

---

## 9. Enabling, and the backfill

Enabling the feature notifies **nobody**. Existing users are seeded to the state
their current balance implies, and an already-low user is seeded ALERTED with no
message. Only future crossings alert. This is the default and the admin page
says so in plain Persian.

The other choice — "also tell the people who are already low" — is a separate,
explicitly confirmed OWNER action with its own confirmation screen. That screen
shows an **estimate**, and says so: balances move and preferences change, and
every unit re-checks eligibility before it queues anything, so the number
actually sent can only be that or lower. Four numbers are worth keeping apart —
the *eligibility estimate at confirmation*, the *queued* count, the *sent* count
and the *skipped/cancelled* count. Only the first is shown on the confirmation
screen, and only as a forecast.

**Authorization happens under the lock.** Whether a cycle already has its
message cannot be answered before the state row is locked: a live wallet
crossing can open that cycle in the gap, and forcing an alert would then open a
second one for a single decrease. The shared transition therefore takes an
`authorizeForceAlert(lockedCycle)` callback, asked *after* the lock with the
cycle the lock revealed. **Nothing observed before the lock may authorise a new
cycle.**

**Every user transaction LOCKS the run row and then judges the claim** — run id,
`RUNNING` status, our owner token, unexpired lease — before it changes anything.
The status check is what enforces cancellation.

The lock, not the check, is what makes this correct. A plain read sees a
snapshot, and a cancellation or takeover can commit the instant afterwards while
the transaction goes on to open a cycle and queue a message. `SELECT … FOR
UPDATE` puts the unit and every mutation of the claim into **one serial order**:
either the cancellation commits first, in which case the lock is granted only
after it and PostgreSQL re-evaluates the row this unit then reads, so the unit
stops; or the unit takes the lock first, in which case the cancellation waits and
takes effect on the *next* unit, after this one has committed atomically. The row
is locked by primary key and judged afterwards, because a predicate that no
longer matches locks nothing at all — and "nothing was locked" cannot be told
apart from "someone else holds it" without a second query.

The lock order is fixed and acyclic: **run claim → alert state → outbox row**.
Nothing takes them the other way — the wallet observer and the reconciliation
sweep only ever take the state lock, and cancellation and takeover only ever take
the run lock — so units cannot deadlock against a checkout or against the admin
surface.

Losing the claim stops the worker immediately, with no transition, no outbox row
and a distinct `lost-claim` outcome. Lease renewal requires the lease to be
**still valid**, so an expired owner cannot silently reclaim a run after a
takeover.

**Progress is part of the unit.** The cursor and the processed/queued/skipped
counters are written in the same transaction as the transition they describe, not
once per page. Committing units first and their bookkeeping afterwards means a
crash in between re-processes the page: the dedupe key still prevents a second
message, but `queuedCount` under-reports and `skippedCount` over-reports, so the
OWNER is shown a run that never happened. Written together, the counters describe
exactly the units that committed, `processedCount` is always
`queuedCount + skippedCount`, and the cursor never moves past work that did not
commit. A unit that throws records nothing — so it is marked durably as attempted
in its own small statement, guarded on still holding the claim, otherwise a row
that always fails would pin the run on it forever.

**Population.** Every ACTIVE, eligible user currently at or below the frozen
threshold, whatever state the machine is in:

| State | Action |
| --- | --- |
| no state row | create the first explicit cycle and notify |
| silent baseline (cycle 0) | open the first real cycle and notify |
| ARMED while low | advance one cycle and notify |
| cycle already produced its message | skip |
| opted out / payment category off / inactive / recovered | skip |

Skipping the first two is what made an earlier cut complete having sent almost
nothing: right after enabling, essentially the whole low-balance population *is*
those two states. Whether a cycle already produced its message is asked of the
deterministic key, never inferred from the state alone.

The backfill is the most conservative thing in the feature:

* **At most one run** can be PENDING or RUNNING, enforced by a partial unique
  index (`… ON t((1)) WHERE status IN ('PENDING','RUNNING')`) — by the database,
  not by application code, so pressing the button twice cannot double-notify.
* It works against the configuration **frozen** when the OWNER confirmed.
  Changing the threshold mid-run does not silently re-target it.
* It advances by keyset in batches of 200 with a durable cursor, so it is
  restart-safe and never loads the user table into memory.
* Every message goes through the **same dedupe key** as the live observer, so a
  user the observer already alerted in this cycle cannot be alerted twice.
* Cancellation takes effect on the next unit that reaches the claim lock.
  Messages already queued are not recalled.

### The candidate count

The confirmation screen's numbers come from **one aggregate query**. No user id
and no dedupe key is ever loaded into the bot process, and the statement carries
three bind parameters however many users exist — an earlier version materialised
every eligible user and sent all their keys as a single `IN` list, which on a
production-sized installation is tens of megabytes of strings and far past
PostgreSQL's 65535-parameter ceiling, so the screen would simply fail.

The classification mirrors the worker's rules case for case:

| Situation | Counted as |
| --- | --- |
| no state row | expected recipient |
| ARMED (any cycle) while at or below the threshold | expected recipient |
| ALERTED, cycle 0 (the silent baseline) | expected recipient |
| ALERTED, cycle > 0, that cycle has no message | expected recipient |
| ALERTED, cycle > 0, that cycle has its message | already notified |
| focused opt-out | opted out of this alert |
| `PAYMENT` category off | opted out of the category |
| not ACTIVE | outside the population entirely |

The ARMED row is the one that used to be wrong. A user re-armed after cycle 3
still has cycle 3's notification, and the old query called them already notified
— while the worker would open cycle 4 and send. The screen therefore promised
*fewer* messages than the run would deliver. Being ALERTED is now part of the
condition, exactly as it is in the transition.

"Recovered" needs no row: the population is `balance <= threshold` and the
re-arm boundary is never below the threshold, so nobody inside the set can be
recovered.

---

## 10. Admin surface

OWNER-only, reached from تنظیمات عمومی → **هشدار کاهش موجودی کیف پول ⚠️**.

The whole page is **aggregate-only** — counts, boundaries and run progress. It
never lists, searches or names a user, so an operator cannot use it to find out
who is short of money.

Actions: enable / disable, edit threshold, edit re-arm margin, view the message
template and its placeholders, preview the rendered message with sample numbers,
start the backfill (behind its confirmation screen), cancel a running backfill,
and refresh.

Numeric entry accepts Persian and Arabic-Indic digits and thousands separators,
and **rejects decimals** — a fractional Toman cannot exist in an INTEGER column,
and silently truncating one would change the boundary the operator believes they
configured.

---

## 11. User preference

`هشدار کاهش موجودی` in تنظیمات اعلان‌ها, backed by
`User.lowBalanceNotificationsEnabled` (defaults to `true`).

It is a **focused** opt-out, checked in addition to the `PAYMENT` category gate:
silencing this one alert does not require silencing every payment notice. The
toggle is only shown while the OWNER has the feature enabled, so a dormant
install advertises nothing.

A preference flipped *after* an alert was queued is still honoured, because
delivery re-checks it (test **L63**).

---

## 12. Schema

Two forward-only migrations. Neither modifies a released one.

**`20260728120000_low_wallet_balance_notifications`**

* enums `LowBalanceAlertStateValue` (ARMED / ALERTED) and
  `LowBalanceBackfillStatus`
* `ALTER TYPE "AutomatedNotificationType" ADD VALUE IF NOT EXISTS
  'WALLET_LOW_BALANCE'`
* `User.lowBalanceNotificationsEnabled BOOLEAN NOT NULL DEFAULT true` — on
  PostgreSQL 11+ this is a catalog-only change: no table rewrite, no long
  `ACCESS EXCLUSIVE` lock, safe on a large `User` table
* `LowBalanceAlertState` — unique on `userId`, indexed on
  `(state, lastObservedBalanceToman)` and `updatedAt`, FK `ON DELETE CASCADE`,
  `CHECK ("alertCycle" >= 0)`
* `LowBalanceBackfillRun` — plus the partial unique index that permits at most
  one active run

**`20260729120000_low_balance_reconciliation_lease`**

* `LowBalanceBackfillRun.ownerToken` / `.leaseExpiresAt` — the durable worker
  claim
* `LowBalanceReconciliationState` — the singleton control record: owner token,
  lease expiry, repair cursor, sweep health counters, and a
  `completedSweepCount >= 0` check. Coordination only; it holds no user
  identity, balance or notification data.

---

## 13. Financial invariants

* No code in this feature writes `balanceToman`, `totalSpentToman`,
  `totalChargedToman` or any `WalletTransaction` row (test **L31**).
* No Telegram call happens inside a financial transaction.
* A rolled-back financial transaction takes its notification with it
  (test **L30**).
* Checkout, renewal, referral and settlement behaviour is unchanged: the
  observer is an additive call after the ledger write and returns nothing the
  callers act on.

---

## 14. Rollout order

1. Deploy. Nothing is enabled; nothing is notified.
2. Run migrations.
3. Confirm the worker heartbeat.
4. Enable the master switch. Existing users are seeded silently; only future
   crossings alert.
5. Tune the threshold and margin, using the preview to check the rendered copy.
6. *Optionally* — and only deliberately — run the backfill.

Disabling is always safe: both worker schedulers are removed on the next
reconcile without a restart, queued alerts are cancelled at send time, and no
state or history is deleted.

---

## 15. Tests

**124 numbered cases, `L01`–`L122`**, across six suites:

| Suite | Cases | Covers |
| --- | --- | --- |
| `low-balance.test.ts` | 34 | pure contract, DB state machine, concurrency, financial invariants |
| `low-balance-worker.test.ts` | 33 | snapshot, admin mutations, backfill population, sweep, send-time policy |
| `low-balance-first-observation.test.ts` | 18 | first-observation semantics, concurrent creation, atomicity, lease |
| `low-balance-multi-replica.test.ts` | 7 | concurrent replicas, cursor progress, constrained pool |
| `low-balance-cycle-authority.test.ts` | 14 | stale-cycle supersession, locked backfill authorization, claim enforcement |
| `low-balance-linearizability.test.ts` | 18 | mid-unit cancellation and takeover, crash-consistent progress, bounded counting, atomic configuration |

The load-bearing ones:

| Case | What it proves |
| --- | --- |
| L25 / L26 | Two, then twelve, concurrent crossing debits produce exactly one alert |
| L30 | A rolled-back transaction takes the notification with it |
| L31 | The observer never changes a balance, a total or the ledger |
| L32 / L32b | Logic errors are swallowed; DB errors roll back atomically |
| L66 | The first post-enable debit that crosses alerts exactly once |
| L72 / L73 | Concurrent FIRST observations: no wallet mutation fails, one cycle |
| L76 / L77 / L78 | Failure after the transition, and after the outbox insert, rolls the unit back |
| L85 | Rows beyond one bounded pass are reached, not starved |
| L87–L90 | Four replicas advance one backfill without double-notifying |
| **L91 / L92** | A stale cycle is cancelled as superseded while a newer one stays live, and cancelling it never re-arms the newer cycle |
| **L94 / L95** | A missing or ARMED state cancels safely, creating and reopening nothing |
| **L96** | Repeated delivery attempts are idempotent |
| **L98 / L99 / L100** | Either ordering of a live crossing and the backfill yields exactly one cycle and one message |
| **L101** | A committed cancellation stops every later unit in the batch |
| **L102 / L103** | An expired lease is taken over; the expired owner cannot renew and reclaim |
| **L104** | Counters and cursor never double-count under takeover |
| **L105 / L106** | A cancellation and a takeover landing MID-PAGE: the unit already holding the claim lock completes, everything after it writes nothing |
| **L108** | An interrupted run resumes under another worker with no duplicate, nothing missed, and accurate durable totals |
| **L110** | `queuedCount` equals the number of messages that actually appeared |
| **L113** | An ARMED user holding an old cycle's notification is still an expected recipient |
| **L118** | 100,000 users counted with bounded memory and no oversized statement |
| **L119** | A failure between the boundary and the version write rolls both back |
| **L120 / L121** | Concurrent configuration writers produce monotonic versions and one valid combined snapshot |
| **L122** | A backfill freezes ONE coherent configuration tuple |

The mid-unit races are pinned with real locks: a transaction holding
`SELECT … FOR UPDATE` on a user's state row stops that user's unit *after* it has
taken the claim lock, which is the only moment at which a cancellation or a
takeover can be made to queue behind it. Waiting backends are detected through
`pg_locks`, so nothing depends on a sleep. One run therefore exercises **both**
orderings: the pinned unit takes the claim first and completes atomically while
the interference waits, and the interference then commits before the next unit
reaches the lock and stops it.
