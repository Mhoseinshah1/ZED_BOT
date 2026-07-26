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

A queued alert is a claim about the past. Before delivery,
`revalidateLowBalanceForDelivery` re-checks against the **database**:

1. the feature is still enabled;
2. the user still exists, is ACTIVE, and has not opted out;
3. the balance is still low.

A user who topped up between the crossing and the delivery must not receive a
"you are running out of money" warning. Cancelling is always preferred to
sending something already false.

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
explicitly confirmed OWNER action with its own confirmation screen showing the
exact candidate count before anything is queued.

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
* Cancellation takes effect between batches. Messages already queued are not
  recalled.

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

**92 numbered cases, `L01`–`L90`**, across four suites:

| Suite | Cases | Covers |
| --- | --- | --- |
| `low-balance.test.ts` | 34 | pure boundary/parsing contract, the DB-backed state machine, concurrency, financial invariants, admin read model |
| `low-balance-worker.test.ts` | 33 | payload snapshot, admin mutations, backfill population, reconciliation, send-time policy |
| `low-balance-first-observation.test.ts` | 18 | first-observation semantics, concurrent state creation, atomicity, lease behaviour |
| `low-balance-multi-replica.test.ts` | 7 | concurrent replicas, cursor progress, constrained connection pool |

The load-bearing ones:

| Case | What it proves |
| --- | --- |
| L25 / L26 | Two, then twelve, concurrent crossing debits produce exactly one alert |
| L28 | A duplicate dedupe key inserts zero rows rather than raising |
| L30 | A rolled-back transaction takes the notification with it |
| L31 | The observer never changes a balance, a total or the ledger |
| L32 / L32b | Logic errors are swallowed; DB errors roll back atomically |
| L45 | A second backfill start is rejected by the database |
| L47 / L47b / L47c | Already-notified skipped; silent baseline and no-state users notified |
| L61 | Recovery is judged against the cycle's own boundary |
| L65 | A stale alert re-arms only its own cycle |
| **L66** | The first post-enable debit that crosses alerts exactly once |
| **L67 / L68 / L69 / L70** | Historically low stays silent; above-threshold arms; a first-observation top-up never alerts; the hysteresis band arms silently |
| **L72 / L73** | Two, then twelve, concurrent FIRST observations: no wallet mutation fails, one state row, one cycle |
| **L76 / L77 / L78** | Failure after the transition, and after the outbox insert, rolls the whole unit back; every committed cycle has its message |
| **L79 / L80** | One lease holder at a time; an expired lease is taken over |
| **L83 / L86** | No advisory lock is left behind, including with `connection_limit=1` |
| **L85** | Rows beyond one bounded pass are reached, not starved |
| **L87 / L88 / L89** | Four replicas advance one backfill without double-notifying; an abandoned claim is taken over; a live claim is respected |
| **L90** | A backfill interleaved with live crossings notifies each user exactly once |
