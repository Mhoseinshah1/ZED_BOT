# Backup restore runbook (server-only, manual)

Restore is **deliberately never executed from Telegram or by the CLI** —
`zedbot restore` / `zedbot restore-help` print instructions and exit. This
runbook is the authoritative step-by-step procedure; run every command
yourself, as root, on the server. For a total-server-loss scenario start
with [backup-disaster-recovery.md](backup-disaster-recovery.md) instead.

Placeholders `<POSTGRES_USER>` / `<POSTGRES_DB>` come from
`/opt/zedbot/app/.env` — never paste those values into chats or logs.

## 0. Before anything: take a fresh backup

A restore overwrites the live database. **Always** snapshot the current
state first, even if you believe it is broken:

```bash
zedbot backup
```

## 1. Pick and verify the file to restore

```bash
zedbot backup list                       # newest first, with type column
zedbot backup verify zedbot-db-YYYYMMDD-HHMMSS.dump.enc   # or .dump / .sql.gz / a timestamp id
```

`backup verify` checks the sha256 against the manifest when one exists,
then the format itself (`pg_restore --list` for dumps, full
decrypt+verify via the worker CLI for `.dump.enc`, `gzip -t` for legacy
files). Do not restore a file that fails verification.

## 2. Stop the application services (keep postgres running)

```bash
cd /opt/zedbot/app
docker compose stop api bot worker
```

## 3a. Restore a plain custom-format dump (`.dump`)

```bash
docker compose exec -T postgres pg_restore --clean --if-exists \
  -U <POSTGRES_USER> -d <POSTGRES_DB> \
  < /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.dump
```

The file travels over stdin, so nothing is copied into the container and
no credentials appear on any command line (`pg_restore` runs inside the
postgres container over the local socket).

## 3b. Restore an encrypted dump (`.dump.enc`)

ZBK1 files are AES-256-GCM with an scrypt-derived key — `openssl enc`
**cannot** decrypt them (see [backup-encryption.md](backup-encryption.md)).
Decrypt with the worker's own code (openssl-free; the password is read
from the container's `BACKUP_ENCRYPTION_PASSWORD` — it never appears on a
command line):

```bash
# 1) Verify first (also proves the password in .env is the right one):
zedbot backup verify zedbot-db-YYYYMMDD-HHMMSS.dump.enc

# 2) Decrypt into the shared backup mount. The output name deliberately
#    does NOT start with "zedbot-db-" so it never shows up in backup
#    listings or retention.
cd /opt/zedbot/app
docker compose run --rm --no-deps worker node -e '
const dir = "/var/lib/zedbot/backups/";
import("./apps/worker/dist/backup/verify.js")
  .then((m) => m.decryptBackupToFile(
    dir + process.argv[1],
    dir + process.argv[2],
    process.env.BACKUP_ENCRYPTION_PASSWORD,
  ))
  .then(() => console.log("decrypted OK"))
  .catch(() => { console.error("decrypt failed (wrong password or corrupt file)"); process.exit(1); });
' zedbot-db-YYYYMMDD-HHMMSS.dump.enc restore-YYYYMMDD-HHMMSS.dump

# 3) Restore the decrypted dump exactly as in 3a:
docker compose exec -T postgres pg_restore --clean --if-exists \
  -U <POSTGRES_USER> -d <POSTGRES_DB> \
  < /opt/zedbot/backups/restore-YYYYMMDD-HHMMSS.dump

# 4) Remove the plaintext copy as soon as the restore succeeded:
rm -f /opt/zedbot/backups/restore-YYYYMMDD-HHMMSS.dump
```

Notes: the decryptor creates the output exclusively (it refuses to
overwrite an existing file, mode 600, owned by the runtime UID). A
`decrypt failed` here means wrong password or a tampered/corrupt file —
the two are indistinguishable by design.

## 3c. Restore a legacy plain-SQL backup (`.sql.gz`)

Legacy files are unencrypted and only integrity-checked with `gzip -t`
(no structural verification exists for them):

```bash
gunzip -c /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB>
```

## 4. Start everything and verify

```bash
docker compose up -d
zedbot doctor
```

Then, in the bot: پنل مدیریت → «گزارشات / بکاپ 🛡» → «وضعیت سیستم 🩺» —
database, Redis, worker heartbeat and the latest-backup line should all be
green (see [system-health.md](system-health.md) for what each line means).

## Post-restore notes

- The restored database contains the `BackupOperation` rows **as of the
  backup**, while the backup *files* on disk are whatever the host
  currently holds. Files without a matching row render as «دستی /
  نامشخص» in the bot's list and rows whose file is gone simply do not
  appear — this drift is cosmetic and self-corrects as new backups run.
- Deliveries (`SystemLogDelivery`) restored in `PENDING`/`FAILED` state may
  be re-sent or expire silently; operational logs are informational, no
  action needed.
- If the restore was part of credential rotation, remember old encrypted
  backups still require the old `BACKUP_ENCRYPTION_PASSWORD`.

## Common failure modes

| Symptom | Cause / fix |
| --- | --- |
| `pg_restore: error: … does not exist` noise during `--clean` | Harmless with `--if-exists`; without it, expected on a fresh database |
| `decrypt failed` in step 3b | Wrong `BACKUP_ENCRYPTION_PASSWORD` (check the `.env` that was active when the backup was created) or a corrupt file — try another backup |
| `output-exists` style refusal in step 3b | A previous decrypt left `restore-….dump` behind — remove it first |
| Restore hangs / connection refused | postgres container not running (`zedbot start`, `zedbot logs postgres`) |
| Bot list shows the restored era's backups but files are missing | Expected drift, see post-restore notes |
