# Referral migration lineage & dual-checksum activation

`20260719180000_referral_affiliate_commissions` has existed in **two deployed byte
forms** with an **identical final schema** but different checksums. This document
records the empirical audit and how the system supports both safely.

## 1. The two historical variants (audited, not assumed)

Checksums were computed from the exact repository bytes and **verified against the
values `prisma migrate deploy` actually records** in `_prisma_migrations.checksum`
using the installed Prisma version (**6.19.3**), on real PostgreSQL 16.

| Variant | Source | Bytes | Prisma checksum (`_prisma_migrations.checksum`) |
|---------|--------|-------|--------------------------------------------------|
| **ORIGINAL** (PR #108, and the current restored file) | commit `62c1e66` / `main` | 1061 | `eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59` |
| **PR #110** (embedded duplicate-orderId preflight block) | commit `83d7ea9` | 2225 | `9acc8e3b5e2720a1bc1166c08a3ced30a7108f21eee11b654943d07e6a44a970` |

Current on-disk file (git blob `d68708f`) is **byte-identical to the PR #108
original** — its SHA-256 is `eadac093…`.

### Checksum algorithm (empirical)

- The recorded checksum is the **lowercase hex SHA-256 of the RAW file bytes**.
- **Prisma does NOT normalize line endings.** A CRLF copy of the same logical SQL
  records the CRLF-bytes hash (`00f1687433b4424e632d87b9c4a23741f6b3632ef81c37f0eb5abdb3e6ea5254`),
  **not** the LF-bytes hash. So our checksum helper must NOT normalize either, or it
  would disagree with a genuinely CRLF-applied migration. (`.gitattributes` pins the
  migration SQL to `eol=lf` so on-disk bytes stay LF on every platform.)

### `prisma migrate deploy` tolerates the edited file (empirical)

Restoring the file to the PR #108 form does **not** break deployment on a database
that applied the PR #110 form. `prisma migrate deploy` **only applies pending
migrations**; it does **not** re-verify checksums of already-applied migrations. In a
direct test — apply the PR #110 form, swap the on-disk file to the PR #108 form, add a
new pending migration, run `migrate deploy` — the new migration applied cleanly (exit
0), no "migration modified" error. (Checksum re-verification is a `migrate dev` /
`migrate status` behaviour, not `deploy`.)

**Consequence:** the only place the checksum mismatch mattered was the custom
**referral activation gate**, which previously required `on-disk == recorded`. That
is what §3 fixes.

## 2. The file stays immutable

`packages/database/prisma/migrations/20260719180000_.../migration.sql` is **never
edited again** (no re-inserted preflight, no comments, no whitespace/line-ending
changes). `referral-migration-checksum.test.ts` fails if its SHA-256 ever changes.

## 3. Dual-lineage activation gate

The migration-history activation check (`referral-activation.service.ts` +
`packages/database/src/migration-lineage.ts`) evaluates the one known migration to a
typed status:

| status | meaning | activation |
|--------|---------|-----------|
| `EXACT_MATCH` | on-disk SHA-256 == recorded | allowed |
| `KNOWN_COMPATIBLE_LEGACY_VARIANT` | recorded == known PR #110 checksum **and** every schema postcondition passes | allowed **with a non-blocking warning** |
| `CHECKSUM_DRIFT` | recorded is neither known checksum | **blocked** |
| `SCHEMA_POSTCONDITION_FAILED` | recorded == PR #110 checksum but a schema check failed | **blocked** |
| `FILE_MISSING` | the migration file / dir is absent | **blocked** |

Every OTHER migration still requires an exact `on-disk == recorded` match. The schema
postconditions verified before accepting the legacy variant: `REVERSED` enum value;
`reversalWalletTransactionId` and `reversedAt` columns; `ReferralCommission_orderId_key`
index exists and is UNIQUE; no duplicate non-null `orderId` rows; the migration is
finished, not rolled back; and no migration failure is present.

The OWNER activation page shows the state as one of **سالم / نسخه قدیمی سازگار /
ناسازگار / فایل migration موجود نیست / ساختار پایگاه‌داده ناقص**. Only an UNKNOWN
checksum or failed postconditions block. **Disabling is never gated.**

## 4. Operator lineage-status command

```bash
sudo bash scripts/referral-migration-lineage-status.sh
```

It reports the lineage status, the classification (`ORIGINAL` / `PR110_COMPATIBLE` /
`UNKNOWN` / `NOT_APPLIED`), and each schema postcondition. It is **read-only**: it
moves no money, changes no rows, and never rewrites migration metadata. It prints no
credentials / `DATABASE_URL` and no order/user/commission ids (the SHA-256 checksums
it prints are of a public migration file, not secrets).

### Manual metadata reconciliation — NOT required

Normalising `_prisma_migrations.checksum` is **not necessary**: `migrate deploy`
tolerates the mismatch and the activation gate accepts the known PR #110 checksum.
The application **never** rewrites the recorded checksum automatically.

If an operator nonetheless wants to make a PR #110-lineage database record the
current ORIGINAL checksum (purely cosmetic — it silences the "نسخه قدیمی سازگار"
warning), do so **only** after a backup and after confirming the schema is intact:

1. `zedbot backup` (or `scripts/backup-db.sh`).
2. `sudo bash scripts/referral-migration-lineage-status.sh` — confirm
   `classification: PR110_COMPATIBLE` and **all** schema postconditions `OK`.
3. Only then, as a deliberate manual step (there is no Prisma command for this):
   ```sql
   -- Verify the target first:
   SELECT migration_name, checksum FROM _prisma_migrations
   WHERE migration_name = '20260719180000_referral_affiliate_commissions';
   -- Then set it to the current file's checksum (the ORIGINAL constant):
   UPDATE _prisma_migrations
   SET checksum = 'eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59'
   WHERE migration_name = '20260719180000_referral_affiliate_commissions';
   ```
4. Re-run the lineage-status command — it should now report `EXACT_MATCH` / `ORIGINAL`.

This step is optional and safe to skip forever; the compatible legacy lineage
activates normally without it.
