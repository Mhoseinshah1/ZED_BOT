# Versioned mandatory Terms & Conditions

Mandatory terms acceptance with a real, auditable version history. Publishing a
new version requires every user to accept again; the exact body each user
accepted stays recoverable forever.

This replaces the previous behaviour, where the terms were a single editable
`terms_text` template and acceptance was a single `User.termsAcceptedAt`
timestamp — an edit to that template silently changed what "accepted" meant for
everyone who had already accepted.

---

## 1. Model

| Model             | Purpose |
| ----------------- | ------- |
| `TermsDocument`   | One version of the terms. `version` (unique, assigned at publish), `body`, `status` (`DRAFT` / `PUBLISHED` / `ARCHIVED`), `contentHash`, `createdByAdminId`, `publishedByAdminId`, `createdAt`, `updatedAt`, `publishedAt`. |
| `TermsAcceptance` | One user's acceptance of one document. Unique on `(userId, termsDocumentId)`, plus a denormalized `termsVersion`, `acceptedAt` and a coarse `source` (`BOT` / `MIGRATION`). |

`User.termsAcceptedAt` is **kept** as the legacy "latest acceptance" timestamp.
It is written in the same transaction as the acceptance row, so the two can
never disagree — but the gate reads the acceptance row, never the timestamp.

### Database-level invariants

Two rules are enforced by PostgreSQL itself, not by application code alone, so
they hold even against manual SQL:

```sql
-- At most ONE published document, ever.
CREATE UNIQUE INDEX "TermsDocument_single_published_key"
    ON "TermsDocument" ((1)) WHERE "status" = 'PUBLISHED';

-- A draft has no version; a published/archived document always has one.
ALTER TABLE "TermsDocument"
    ADD CONSTRAINT "TermsDocument_version_status_check"
    CHECK (("status" = 'DRAFT') = ("version" IS NULL));
```

Together with `TermsDocument_version_key` (unique version) and
`TermsAcceptance_userId_termsDocumentId_key`, "two current documents",
"duplicate version numbers", "a draft that already claimed a version" and
"a duplicate acceptance" are all unrepresentable.

---

## 2. Lifecycle

```
            ┌──────────────────────────────────────────────┐
            │                                              │
  create ──▶ DRAFT ──edit──▶ DRAFT ──publish──▶ PUBLISHED ─┘ (next publish)
            │                                    │
          delete                                 ▼
            │                                 ARCHIVED
            ▼
         (removed)
```

- **Creating a draft** seeds it from the current published body, so the operator
  edits the real current terms instead of a blank page. Only one draft may exist
  at a time.
- **Editing a draft is invisible to users.** The gate only ever reads the
  `PUBLISHED` document, and every draft write filters on `status: DRAFT`.
- **Publishing** happens in one serialized transaction: assign the next version
  (`max(version) + 1`), archive the previously published document, flip the
  draft to `PUBLISHED` with its version, content hash and timestamp.
- **A published document is never modified in place.** Changing the terms means
  publishing a new version. The old one is archived, not rewritten.
- **Deleting** only ever targets a draft. Published and archived documents cannot
  be deleted from the bot at all.

---

## 3. The gate

Gate order is unchanged (`apps/bot/src/middlewares/user-access.middleware.ts`):

1. maintenance mode (`maintenance_mode`)
2. account status (`BLOCKED` / `DISABLED` / `DELETED`)
3. **mandatory terms** (`terms_required`)
4. mandatory channel membership (`force_join_enabled`)
5. the normal handler

The terms step blocks when enforcement is on, a document is published, and the
user has **no acceptance row for that document**. Because acceptance is keyed to
the document id, publishing a new version re-gates everybody without touching a
single user row.

Admin-area handlers and the pre-gate payment updates are unaffected — they are
registered before the gated user area, exactly as before.

### Enforcement enabled with nothing published

Unreachable through the bot: enabling is refused unless a valid published
version exists, and that check runs inside the same locked transaction as the
write. If the state occurs anyway (manual SQL, a partial restore), the gate
**steps aside and raises a durable OWNER alert**
(`terms.enforcement_misconfigured`) rather than blocking everyone.

Blocking would deny every user access with no action available to them — only
the OWNER can publish. This mirrors the force-join D4 rule for an unverifiable
required channel: never brick the user base over an operator misconfiguration;
alert instead.

---

## 4. Callback identity

The old static `terms:accept` meant "accept whatever the terms currently are".
That is unsafe once terms are versioned: a button rendered next to version 3
would still be honoured after version 4 was published, marking the user as
having accepted a body they never saw.

Every accept button now carries the document it was rendered with:

```
user:terms:accept:<8-char document id prefix>      // 26 bytes, limit is 64
```

- The screen and its button are built from **one document object**
  (`buildTermsScreen`), so "screen shows N, button accepts M" cannot be
  constructed.
- The short id is resolved with an **ambiguity check**: an unknown *or*
  ambiguous prefix resolves to `null`, never to "probably this one".
- `recordTermsAcceptance` refuses any id that is not the currently published
  document.

> **Invariant:** a user can accept only the exact document body that was
> rendered with that button.

Routing binds to this ASCII contract and never to the visible Persian label —
every label in this feature is operator-editable, so deriving behaviour from
text would let a text edit re-route or disable the gate.

**Legacy keyboards.** `terms:accept` (sent before the upgrade) names no
document, so it accepts nothing. It is still routed, and answers with the
current terms and the current button, which is exactly what the user needs.

---

## 5. Acceptance

`recordTermsAcceptance(userId, documentId)`:

- rejects anything that is not the currently published document (`STALE`),
- is **idempotent** — a second press returns the original row; `acceptedAt` is
  never overwritten and no duplicate row appears (a concurrent double-press is
  resolved by the unique index and reported as an idempotent success),
- writes the acceptance row and `User.termsAcceptedAt` in **one transaction**,
- touches **nothing else**: no balance, order, referral, checkout, payment,
  force-join bypass, role or account status.

Maintenance mode and account status are applied **before** anything is recorded
(`ensurePreTermsAccess`), so a blocked user pressing a stale accept button
writes no row at all. The terms and force-join steps are deliberately not
applied there — this action *is* the terms step, and force join must stay after
it.

This path deliberately does **not** take the configuration advisory lock.
Publishing re-gates the whole user base at once, which is exactly when a burst
of acceptances arrives; serializing all of them behind the OWNER's lock would
queue every user while each held a pooled connection. Correctness does not need
it: the published document is re-read inside the transaction, so a publish
committing meanwhile either makes this read return the NEW document (stale
button rejected) or leaves it unchanged (an acceptance of the OLD document,
which is historically valid and still does not satisfy the gate).

After a successful acceptance the handler answers `قوانین تایید شد ✅` and
re-runs the **full** access path, so the user continues to the force-join screen
or the normal menu according to the gate order.

---

## 6. Concurrency

Every **configuration** mutation — publish, draft create/edit/delete, enable,
disable — takes one dedicated transaction-level advisory lock. The repair
migration `20260727130000` takes the same lock, because deployments keep the old
containers serving traffic while migrations run. Recording an **acceptance**
deliberately does not (see below):

```ts
const TERMS_CONFIG_LOCK = "zedbot-terms-config";
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TERMS_CONFIG_LOCK}))`;
```

Row locks cannot do this job. "There is no published document yet" and "there is
no draft yet" are statements about an **empty row set**, and `SELECT … FOR
UPDATE` over an empty set locks nothing — two concurrent publishes would both
read `max(version) = 3`, both mint version 4, and both try to become current. A
transaction-level advisory lock exists independently of any row and is released
automatically at `COMMIT`/`ROLLBACK`.

It is a **different namespace** from the force-join lock: the two subsystems are
independent and must never block each other.

`apps/bot/tests/terms-concurrency.test.ts` fires genuinely parallel operations
and asserts the surviving invariants. Neutralizing `lockTermsConfig` makes 6 of
its 12 cases fail, so the lock is demonstrably load-bearing rather than
decorative.

### The acceptance/publication race

If a user presses the version-N button at the moment version N+1 is published,
`recordTermsAcceptance` re-reads the published document inside its own
transaction and **rejects the stale acceptance before inserting anything**.

It does this *without* taking the configuration lock. Acceptance is the one hot
path here — every user hits it after a publication — and serializing all of them
behind the OWNER's lock would turn a routine publish into a stampede. It does not
need the lock to be correct: the insert is keyed to one specific document id, and
`@@unique([userId, termsDocumentId])` makes a duplicate impossible, so a `P2002`
is simply read as "already accepted".

A version-N acceptance may therefore legitimately *land* after version N+1 is
published — it is a truthful historical record of a body the user really was
shown. What can never happen is an acceptance row for N+1, because no button for
N+1 was ever rendered to that user. Whichever order the two transactions commit
in:

- the user is never marked as having accepted N+1,
- and they are still required to accept the current version.

---

## 7. Admin panel

`تنظیمات عمومی ⚙️` → `قوانین و شرایط 📜`. **OWNER-only**, re-checked on every
route including the text flow, so a role revoked mid-flow stops the very next
step. A non-OWNER admin is told plainly; a non-admin gets no answer at all.

The overview shows enforcement state, the current published version and its
publication date, whether a draft exists, the acceptance counts and a safe
preview of both bodies.

| Button | Action |
| ------ | ------ |
| `فعال‌سازی تایید قوانین ✅` | Enable enforcement (refused without a published version) |
| `غیرفعال‌سازی تایید قوانین ❌` | Disable enforcement (never destructive) |
| `ایجاد پیش‌نویس جدید ➕` | Create a draft seeded from the published body |
| `ویرایش پیش‌نویس ✏️` | Replace the draft body via a session-bound text flow |
| `پیش‌نمایش 👁` | Published version and draft side by side |
| `انتشار نسخه جدید 🚀` | Publish confirmation |
| `حذف پیش‌نویس 🗑` | Delete the draft (confirmed) |
| `تاریخچه نسخه‌ها 📚` | Version history, paginated in the database |
| `آمار پذیرش 📊` | Aggregate acceptance counts |
| `بازگشت` | Back to general settings |

The publish confirmation states the current version, the proposed new version, a
preview and the warning that everyone must accept again. Its button is
`انتشار و الزام پذیرش مجدد 🚀`, and it **carries the draft's identity** — a stale
confirmation publishes nothing rather than publishing whatever draft happens to
exist when it is pressed.

### Draft text flow

Armed as `terms:draft_body` with the target document id in the session. The body
is validated (non-empty after stripping whitespace and zero-width filler, at most
3,500 characters). A validation failure keeps the flow armed so the OWNER can
simply retype. `/start`, `/admin` and any other command unwind the flow first —
`termsCommandEscapeHandler` is registered ahead of the command composers in
`app.ts` — so a command is never stored as the terms body.

---

## 8. Enable / disable semantics

| State | Behaviour |
| ----- | --------- |
| Disabled | No gate at all. |
| Enabled + valid published version | Acceptance required. |
| Enabling with no published version | Refused with exactly `ابتدا یک نسخه معتبر از قوانین را منتشر کنید.` |
| Disabling | Documents and acceptance history preserved. |
| Re-enabling the **same** version | Nobody accepts again. |
| Publishing a **new** version | Everybody accepts again. |

---

## 8b. Rendering bounds

Telegram rejects a text message over 4,096 characters, `safeReply` swallows the
400, and the gate still blocks — so an oversized terms screen would leave a user
unable to proceed *and* unable to see why, forever. Bodies are capped at 3,500,
but the title is an operator-editable template and an upgraded install can carry
a large legacy body, so the composed screens are bounded explicitly:

- `buildTermsScreen` clamps the operator-editable **title** to
  `TERMS_TITLE_MAX_LENGTH` (400). 4,096 − 3,500 leaves 596 for the title, the
  version and date lines and the separators, so a conforming body always renders
  in full. The body is **never** shortened: the button accepts the whole
  document, so eliding clauses would record acceptance of unseen text (§4). If a
  legacy over-limit body still will not fit, the screen shows
  `terms_unavailable_text` **with no accept button** — it fails closed rather
  than offering acceptance of a partial document.
- The admin preview splits its budget between the published document and the
  draft. A new draft is seeded from the published body, so both are large at the
  same time — rendering 3,500 of each broke the message for any document over
  ~2,000 characters.
- The repair migration archives an over-limit bootstrapped version 1 and
  publishes **nothing** in its place, so an upgraded install never carries an
  over-limit published version (see §10).

## 9. Privacy

- Stored per acceptance: user id, document id, version, timestamp, and a coarse
  source string. **No IP address, no device fingerprint, no Telegram update
  payload.**
- The admin overview and stats page expose **aggregate counts only** — no user
  id, Telegram id, name or acceptance time reaches any page. The two counts are
  read in one transaction so they cannot straddle a concurrent registration.
  Read them as "ACTIVE users holding an acceptance row for the current version"
  and "every other ACTIVE user" — the latter includes long-dormant accounts, and
  the former includes acceptances backfilled by the upgrade.
- The whole section is OWNER-only, so acceptance data is never shown to
  non-OWNER admins.
- The migration and the bootstrap service report **counts only**; the terms body
  is never logged.
- Terms bodies render as **plain text** (no `parse_mode`) on both the user screen
  and the admin pages, so operator copy cannot inject markup or entities.
  Control characters, bidi overrides and zero-width formatting characters are
  stripped on input; ZWNJ (U+200C) and ZWJ (U+200D) are deliberately preserved
  because both are legitimate letters inside Persian words.

---

## 10. Migration and existing installs

Two forward-only migrations. No existing migration is edited and no existing
column is dropped.

`20260727120000_versioned_mandatory_terms` creates the tables, indexes and
database-level invariants. Its tail performs the one-time legacy bootstrap:

1. If any `TermsDocument` already exists → do nothing (re-run safe).
2. Read `MessageTemplate.currentContent` for `terms_text`. If absent, or
   meaningless after stripping whitespace and zero-width characters → do nothing.
3. Otherwise create **published version 1** from that body, and insert a
   version-1 acceptance for every user with a non-null `termsAcceptedAt`,
   carrying their **original timestamp** and `source = 'MIGRATION'`.

So an upgrade never silently forces the whole user base to accept again, and a
fresh database (which is migrated *before* it is seeded, so the registry is
still empty) fabricates nothing.

`20260727130000_normalize_bootstrapped_terms_body` then repairs what that
bootstrap could not: it copied the legacy body **verbatim**, so a `terms_text`
carrying bidi overrides, direction marks, isolates, zero-width space, a BOM or
control characters — or simply running past 3,500 characters — would have become
a version 1 the admin UI itself could never produce, and one the user screen now
refuses to offer for acceptance at all.

**Version 1 is never rewritten.** The bootstrap already backfilled an acceptance
row for everyone who had accepted the legacy terms, and those rows point at
version 1 by id. Editing that body in place would leave the audit trail claiming
those users accepted wording they never saw. So the repair works by versioning,
not by mutation:

| Bootstrapped version 1 | Outcome |
| --- | --- |
| Already clean and within limits | Untouched. Nobody re-accepts. |
| Dirty, but the text survives normalization intact | v1 → `ARCHIVED`; the cleaned text is **published as version 2**. Users accept once more. |
| Nothing meaningful left after normalization | v1 → `ARCHIVED`; **nothing published**. |
| Longer than 3,500 characters after normalization | v1 → `ARCHIVED`; **nothing published**. |

The last row is deliberate: truncating terms of service and then demanding
acceptance of the remainder would silently drop real clauses. Publishing nothing
is the honest outcome — and it is safe, because enforcement with no published
document is treated as a misconfiguration, so the gate steps aside and alerts
the OWNER instead of locking anyone out until a real version is published.

Normalization matches the application exactly, including preserving ZWNJ and ZWJ
(ordinary Persian letters), and the emptiness test ignores **all** whitespace —
one-argument `btrim` strips only spaces, so a body of, say, a bidi override
wrapped in tabs would otherwise have survived as a blank screen.

Scope is narrow: only the still-published version 1 written by the bootstrap
(no admin author on either side). An archived version 1 is history and is left
alone, and anything an operator published through the bot was already normalized
on the way in. Existing acceptance rows are never modified — they keep pointing
at the exact document, and the exact text, that was accepted.

`bootstrapLegacyTermsDocument()` is an idempotent safety net for installs the
migration cannot help — one restored from a partial backup, for example. It does
nothing once any document exists.

> It has **no automatic caller**: nothing invokes it at startup or during
> seeding, because on a fresh install there is nothing to bootstrap and
> fabricating a version 1 from the seeded default would be wrong. It is a
> programmatic/operator tool, exercised by the test suite.

### Verified upgrade paths

| Scenario | Result |
| -------- | ------ |
| Fresh database | Migrations apply; **no** document fabricated |
| Legacy database with configured `terms_text` and 3 accepting users | Version 1 published; 3 acceptances backfilled with original timestamps; the 2 non-accepting users still owe an acceptance |
| Re-running the bootstrap | No-op (`DOCUMENT_EXISTS`) |

> **Note for installs that never customized `terms_text`.** The seeded default
> («برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید.») is non-empty, so
> it does become published version 1. That is deliberate and changes nothing for
> users: whoever had accepted that exact text is backfilled and is not asked
> again, and if enforcement was off it stays off. Publish version 2 from the
> admin panel when the real terms are ready.

---

## 11. Rollback

Disable enforcement from the admin panel (`غیرفعال‌سازی تایید قوانین ❌`). The
gate stops immediately; documents and acceptance history are untouched, so
re-enabling the same version asks nobody to accept again.

To revert to an older wording, create a draft, paste the old text and publish it
as a **new** version — the archived original is never rewritten, so the history
of what each user accepted stays intact.

---

## 12. Files

| Path | Role |
| ---- | ---- |
| `packages/database/prisma/schema.prisma` | `TermsDocument`, `TermsAcceptance`, `TermsDocumentStatus` |
| `packages/database/prisma/migrations/20260727120000_versioned_mandatory_terms/` | Forward-only migration + legacy bootstrap |
| `packages/database/prisma/migrations/20260727130000_normalize_bootstrapped_terms_body/` | Forward-only repair: normalizes the bootstrapped version 1 |
| `apps/bot/src/services/terms/terms-document.service.ts` | All reads/mutations, advisory lock, validation, bootstrap |
| `apps/bot/src/services/terms/terms-callbacks.ts` | Versioned callback identity contract |
| `apps/bot/src/services/terms/terms-views.ts` | The user terms screen |
| `apps/bot/src/handlers/terms.handler.ts` | User acceptance action + legacy callback |
| `apps/bot/src/handlers/admin-settings/terms-admin.handler.ts` | OWNER admin section |
| `apps/bot/src/middlewares/user-access.middleware.ts` | Gate step 3 |
| `apps/bot/tests/terms-documents.test.ts` | Document/acceptance semantics (43) |
| `apps/bot/tests/terms-gate.test.ts` | Gate, callback identity, screen (21) |
| `apps/bot/tests/terms-admin.test.ts` | OWNER admin UI (34) |
| `apps/bot/tests/terms-concurrency.test.ts` | Real parallel races (12) |
