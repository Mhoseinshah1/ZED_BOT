# Referral migration lineage & dual-checksum activation

`20260719180000_referral_affiliate_commissions` has existed in **two deployed logical
SQL forms** with an **identical final schema** but different checksums, and each form
could have been applied from an **LF** or a **CRLF** checkout. This document records the
empirical audit and how the system supports every verified variant safely.

## 1. The historical variants (audited, not assumed)

Checksums were computed from the exact repository bytes and **verified against the
values `prisma migrate deploy` actually records** in `_prisma_migrations.checksum`
using the installed Prisma version (**6.19.3**), on real PostgreSQL 16.

| Variant | Source | Bytes | Prisma checksum (`_prisma_migrations.checksum`) |
|---------|--------|-------|--------------------------------------------------|
| **ORIGINAL_LF** (PR #108, and the current restored file) | commit `62c1e66` / `main`, LF | 1061 | `eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59` |
| **ORIGINAL_CRLF** (PR #108 form, CRLF checkout) | LF↔CRLF of the above | 1083 | `ae972ad361bd060432a3aa030e0597b91b0bbf4a0bfee2f12e71b0fc27200447` |
| **PR110_LF** (embedded duplicate-orderId preflight) | commit `83d7ea9`, LF | 2225 | `9acc8e3b5e2720a1bc1166c08a3ced30a7108f21eee11b654943d07e6a44a970` |
| **PR110_CRLF** (PR #110 form, CRLF checkout) | LF↔CRLF of the above | 2274 | `00f1687433b4424e632d87b9c4a23741f6b3632ef81c37f0eb5abdb3e6ea5254` |

Current on-disk file (git blob `d68708f`) is **byte-identical to ORIGINAL_LF** — its
SHA-256 is `eadac093…`.

These four values are the **entire allowlist** (`REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST`
in `packages/database/src/migration-checksum.ts`). Anything else classifies as `UNKNOWN`
and is blocked regardless of the current schema.

### Checksum algorithm (empirical)

- The recorded checksum is the **lowercase hex SHA-256 of the RAW file bytes**.
- **Prisma does NOT normalize line endings.** A CRLF copy of the same logical SQL records
  a **different** checksum from the LF copy (e.g. PR #110 records `9acc8e3b…` from LF but
  `00f16874…` from CRLF). So our checksum helper must NOT normalize either, or it would
  disagree with a genuinely CRLF-applied migration. (`.gitattributes` pins the migration
  SQL to `eol=lf` so on-disk bytes stay LF on every platform.)

### `prisma migrate deploy` tolerates the edited file (empirical)

Restoring the file to the PR #108 form does **not** break deployment on a database that
applied the PR #110 form. `prisma migrate deploy` **only applies pending migrations**; it
does **not** re-verify checksums of already-applied migrations. **Consequence:** the only
place the checksum mismatch mattered was the custom **referral activation gate**.

## 2. Migration-attempt selection (deterministic, rollback-safe)

Prisma keeps **every** attempt of a migration in `_prisma_migrations` forever, including
failed and rolled-back rows. A migration that failed, was `migrate resolve --rolled-back`,
then successfully re-applied leaves BOTH the old rolled-back row AND the new successful
row. The authoritative helpers (`packages/database/src/migration-attempts.ts`) therefore:

- `readLatestSuccessfulMigrationAttempt(name)` — `finished_at IS NOT NULL AND rolled_back_at IS NULL`, `ORDER BY started_at DESC LIMIT 1`;
- `readLatestMigrationAttempt(name)` — latest of any outcome, `ORDER BY started_at DESC LIMIT 1`;
- `countCurrentlyFailedOrStuckMigrations()` — `finished_at IS NULL AND rolled_back_at IS NULL` (a **live** failure);
- `classifyMigrationAttempt(...)` → `NOT_APPLIED` / `APPLIED` / `CURRENTLY_FAILED` / `HISTORICALLY_ROLLED_BACK`.

A **historical** rolled-back row does **not** block activation once a later successful
attempt exists — only a **currently** failed/stuck migration blocks. Migration health and
lineage evaluation both consume these same helpers, so selection is deterministic.

## 3. Exact unique-index verification

The one-commission-per-order guarantee is verified against the PostgreSQL catalog
(`verifyReferralOrderIdUniqueIndex`), never by index name alone. The index must:

- be bound to the resolved `ReferralCommission` table OID (`pg_index.indrelid`);
- live in the same schema as `ReferralCommission`;
- have the expected name `ReferralCommission_orderId_key`;
- be `indisunique = true`, `indisvalid = true`, `indisready = true`;
- have `indpred IS NULL` (not partial) and `indexprs IS NULL` (not an expression index);
- have exactly one key column and no INCLUDE columns (`indnatts = indnkeyatts = 1`);
- target exactly `ReferralCommission.orderId`.

A same-named unique index on **another** table has a different `indrelid` and so never
satisfies the check. The no-duplicate non-null `orderId` scan is retained alongside it.

## 4. Schema postconditions run for EVERY accepted lineage

The structural postconditions (`checkReferralSchemaPostconditions`) — `REVERSED` enum
value, `reversalWalletTransactionId` / `reversedAt` columns, the exact unique index above,
and no duplicate `orderId` — are evaluated for **every** accepted lineage, **including
`EXACT_MATCH`**. A correct checksum with a drifted schema (e.g. the unique index was
manually dropped) is `SCHEMA_POSTCONDITION_FAILED` and blocks. Checksum equality alone
never grants activation.

## 5. Dual-lineage activation gate

`evaluateReferralMigrationLineage` maps the ONE known migration to a typed status:

| status | meaning | activation |
|--------|---------|-----------|
| `EXACT_MATCH` | recorded == on-disk (`ORIGINAL_LF`) **and** all schema postconditions pass | allowed |
| `KNOWN_COMPATIBLE_LEGACY_VARIANT` | recorded == a known non-current variant (`ORIGINAL_CRLF` / `PR110_LF` / `PR110_CRLF`) **and** all schema postconditions pass | allowed **with a non-blocking warning** |
| `CHECKSUM_DRIFT` | recorded is not in the empirical allowlist | **blocked** |
| `SCHEMA_POSTCONDITION_FAILED` | recorded is a known variant but a schema check failed | **blocked** |
| `FILE_MISSING` | the migration file / dir is absent | **blocked** |

Every OTHER migration still requires an exact `on-disk == latest-successful checksum`
match. The OWNER activation page shows the state as one of **سالم / نسخه قدیمی سازگار /
ناسازگار / فایل migration موجود نیست / ساختار پایگاه‌داده ناقص**. **Disabling is never gated.**

## 6. Operator lineage-status command

```bash
sudo bash scripts/referral-migration-lineage-status.sh
```

It reports the selected migration attempt and its status, the checksum classification
(`ORIGINAL_LF` / `ORIGINAL_CRLF` / `PR110_LF` / `PR110_CRLF` / `UNKNOWN` / `NOT_APPLIED`),
every schema postcondition, the exact unique-index ownership/column result, the count of
current unresolved migration failures, historical rolled-back attempts (separately), and
the final activation verdict. It is **read-only**: it moves no money, changes no rows, and
never rewrites migration metadata. It prints no credentials / `DATABASE_URL` and no
order/user/commission ids (the SHA-256 checksums it prints are of a public migration file,
not secrets).

## 7. Metadata reconciliation is NOT required (and not automated)

Normalising `_prisma_migrations.checksum` is **not necessary**: `migrate deploy` tolerates
the mismatch and the activation gate accepts every empirically verified historical
checksum. The application **never** rewrites the recorded checksum automatically, and the
normal operational path has **no** metadata-edit step — use the read-only lineage-status
command above to diagnose lineage.

### Emergency-only manual reconciliation (custom-schema safe)

Rewriting migration metadata is an emergency-only, last-resort manual action; it is not
part of any routine runbook. If — and only if — an operator has a specific reason to make a
legacy-lineage database record the current `ORIGINAL_LF` checksum, do so **only** after a
full backup and after `scripts/referral-migration-lineage-status.sh` reports a known
compatible classification with all postconditions `OK`.

On a **custom Prisma schema**, `_prisma_migrations` lives in that schema, but a normal
`psql` session usually defaults to `public`. An unqualified `UPDATE _prisma_migrations …`
would fail — or, worse, update an unrelated `public._prisma_migrations` if one exists. So
the statement **must** pin the schema. Replace `__PRISMA_SCHEMA__` with the schema from
your `DATABASE_URL` `?schema=` parameter (`public` for the default):

```sql
BEGIN;
SET LOCAL search_path TO "__PRISMA_SCHEMA__";
-- Prove you are in the intended schema and targeting the exact row:
SELECT current_schema();
SELECT migration_name, checksum
FROM "__PRISMA_SCHEMA__"._prisma_migrations
WHERE migration_name = '20260719180000_referral_affiliate_commissions';
-- Only if the row above is the intended one, set it to the current file checksum:
UPDATE "__PRISMA_SCHEMA__"._prisma_migrations
SET checksum = 'eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59'
WHERE migration_name = '20260719180000_referral_affiliate_commissions';
COMMIT;
```

Re-run the lineage-status command afterward — it should report `EXACT_MATCH` / `ORIGINAL_LF`.
This step is optional and safe to skip forever; every compatible legacy lineage activates
normally without it.

## 8. The file stays immutable

`packages/database/prisma/migrations/20260719180000_.../migration.sql` is **never edited
again** (no re-inserted preflight, no comments, no whitespace/line-ending changes). Its
SHA-256 stays `eadac093…`; `referral-migration-checksum.test.ts` reads the raw bytes and
fails if any content, whitespace, comment or line-ending changes.
