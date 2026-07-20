# Referral migration preflight & duplicate-orderId recovery

The referral affiliate system enforces **at most one `ReferralCommission` per
order** with a unique index (`ReferralCommission_orderId_key`, created by the
`20260719180000_referral_affiliate_commissions` migration). That migration file is
**immutable** — once applied, its checksum is recorded in `_prisma_migrations` and
must never change. So the "are there already duplicates?" safety check does **not**
live inside the migration. It runs as a **separate deployment step BEFORE**
`prisma migrate deploy`.

## What runs, and when

`scripts/migrate.sh` (invoked by `install.sh` and `update.sh`) runs, in order:

1. **Referral duplicate preflight** — `node packages/database/dist/referral-migration-preflight.js`
2. `prisma migrate deploy`
3. seed

If the preflight exits non-zero, the migration deploy **never runs** and the deploy
aborts with an actionable message.

Run it by hand against the configured database without deploying:

```bash
sudo bash scripts/referral-migration-preflight.sh
```

## What the preflight guarantees

- uses the configured (production) `DATABASE_URL`;
- **moves no money** and **deletes no rows** (a read-only aggregate query);
- prints **no full order / user / commission ids** — counts only;
- **passes** on a clean database and on a brand-new one (the `ReferralCommission`
  table may not exist yet — the check is a safe no-op via `to_regclass`);
- **fails** (exit 1) with the group + row counts when duplicate non-null
  `orderId` commission rows exist.

Example failure message (no ids, only counts):

```
referral-migration-preflight: FAILED — ReferralCommission has 2 order id(s)
carrying duplicate commission rows (4 rows total). ... Resolve the duplicates
(keep the earliest PAID row per orderId and reconcile the wallet ledger for any
extra credit) BEFORE running 'prisma migrate deploy'. ... No money was moved and
no rows were changed.
```

## Operator recovery procedure (duplicate rows)

A legacy database that predates the unique index could, in theory, hold more than
one commission for the same order. Resolve it **before** deploying:

1. **Back up the database** (`zedbot backup` or `scripts/backup-db.sh`).

2. **Find the affected orders** (counts + the specific orderIds — run this yourself,
   on the server, so ids never leave the box):

   ```sql
   SELECT "orderId", count(*) AS n
   FROM "ReferralCommission"
   WHERE "orderId" IS NOT NULL
   GROUP BY "orderId"
   HAVING count(*) > 1
   ORDER BY n DESC;
   ```

3. **For each duplicated order**, keep the **earliest PAID** commission and remove
   the extras. Before deleting an extra row, reconcile any wallet credit it caused:

   - Inspect the `WalletTransaction` rows for that order:
     ```sql
     SELECT id, "userId", "amountToman", type, source, "createdAt"
     FROM "WalletTransaction"
     WHERE "relatedOrderId" = '<orderId>' AND source = 'REFERRAL'
     ORDER BY "createdAt";
     ```
   - If an extra commission credited the referrer twice, post a compensating
     `SYSTEM_ADJUSTMENT` debit (source `REFERRAL`) for the over-credited amount, so
     the ledger nets to a single commission. Never edit historical rows in place —
     the ledger is append-only.
   - Then delete the redundant commission row(s), keeping the earliest PAID one:
     ```sql
     DELETE FROM "ReferralCommission"
     WHERE "orderId" = '<orderId>'
       AND id <> (
         SELECT id FROM "ReferralCommission"
         WHERE "orderId" = '<orderId>'
         ORDER BY ("status" = 'PAID') DESC, "createdAt" ASC
         LIMIT 1
       );
     ```

4. **Re-run the preflight** — it must now pass:

   ```bash
   sudo bash scripts/referral-migration-preflight.sh
   ```

5. **Deploy** normally (`zedbot update`), which re-runs the preflight and then
   `prisma migrate deploy`.

## Why this is safe for the migration history

Because the check is a separate step, the shipped migration files are never edited
after they are applied. The **activation integrity gate** (see
`referral-affiliate-system.md`) additionally verifies, before the OWNER can enable
payouts, that every applied migration's on-disk SHA-256 still matches the checksum
recorded in `_prisma_migrations` — so a tampered or drifted migration history blocks
activation instead of silently shipping.
