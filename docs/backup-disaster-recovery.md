# Disaster recovery: full server loss

Procedure for rebuilding a ZED_BOT installation from nothing but off-server
copies of two artifacts. Ordinary single-file restores are covered by
[backup-restore-runbook.md](backup-restore-runbook.md) — this document is
for "the server is gone".

## What you must have stored off-server, in advance

1. **The `.env` file** (`/opt/zedbot/app/.env`) — it contains
   `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_SECRET`,
   `INTERNAL_API_TOKEN`, the bot token and, critically,
   **`BACKUP_ENCRYPTION_PASSWORD`**. Encrypted backups are permanently
   unreadable without that password.
2. **The latest verified database backup** —
   `zedbot-db-YYYYMMDD-HHMMSS.dump[.enc]` (ideally with its
   `.manifest.json` sidecar, so the sha256 can be checked after transfer).

If you only have the update safety archive (`zedbot_backup_*.tar.gz`), it
contains both a `.env` copy and a database dump — extract it and proceed
with those.

## Recovery steps

### 1. Reinstall on a fresh server

Fresh Ubuntu 24.04/26.04, root, with the domain's DNS already pointing at
the new machine:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
```

Answer the prompts with anything sane — the generated secrets will be
replaced in the next step.

### 2. Restore the saved `.env`

```bash
cd /opt/zedbot/app
docker compose down
cp /path/to/saved/.env /opt/zedbot/app/.env
chmod 600 /opt/zedbot/app/.env
zedbot env-check          # key-name validation only, never prints values
zedbot start
zedbot doctor
```

`docker compose down` before swapping `.env` matters: postgres initializes
its data directory with the password active at first boot. Because the
installer already initialized `/opt/zedbot/data/postgres` with the *new*
generated password, the saved `POSTGRES_PASSWORD` will no longer match.
Easiest fix on a fresh install (no data worth keeping yet):

```bash
docker compose down
rm -rf /opt/zedbot/data/postgres
zedbot start              # postgres re-initializes with the restored password
bash scripts/migrate.sh   # schema + seed, so pg_restore has a database to clean into
```

### 3. Restore the latest verified backup

```bash
cp /path/to/saved/zedbot-db-*.dump* /opt/zedbot/backups/
zedbot repair backups     # ownership 1000:1000, mode 750/640
zedbot backup verify zedbot-db-YYYYMMDD-HHMMSS.dump.enc
```

Then follow [backup-restore-runbook.md](backup-restore-runbook.md) step 2
onward (stop app services → decrypt if needed → `pg_restore --clean
--if-exists` → start).

### 4. Re-enable HTTPS

```bash
zedbot nginx
zedbot ssl
zedbot https-status
```

### 5. Verification checklist

- `zedbot doctor` — all core checks PASS, backup-dir checks PASS.
- In the bot: «گزارشات / بکاپ 🛡 → وضعیت سیستم 🩺» — دیتابیس ✅, Redis ✅,
  Worker ✅, «نوشتن Worker ✅», pg_dump version shown, آخرین بکاپ listed.
- Create one fresh backup («ساخت بکاپ دیتابیس 💾» or `zedbot backup`) and
  confirm it reaches `VERIFIED`.
- Log group: the binding (`log_group_chat_id`) lives in the restored
  database, so it survives the restore — press «بررسی اتصال 🧪» on
  «تنظیمات گروه لاگ 📝»; if the group or topics were deleted in the
  meantime, run «ساخت موضوعات پیش‌فرض» or re-bind with `/setloggroup`.
- Spot-check business data: an admin `/admin` login, a user lookup, a
  service page (panel connectivity).

## Common failures

| Symptom | Cause / fix |
| --- | --- |
| `password authentication failed for user "zedbot"` | Postgres data dir initialized with a different password than the restored `.env` — see step 2 (re-initialize the fresh data dir, or update `POSTGRES_PASSWORD`/`DATABASE_URL` to match the data dir you actually kept) |
| `decrypt failed` on the backup | Wrong/rotated `BACKUP_ENCRYPTION_PASSWORD` — you need the password that was active when that file was created |
| Worker line ❌ on the health page, backups impossible | `zedbot doctor --fix` (backup dir owner/mode), then `zedbot restart`; confirm `zedbot logs worker` shows both queue consumers ready |
| sha256 mismatch on `zedbot backup verify` | The file was corrupted in transfer — re-copy it, compare against the manifest's `sha256` |
| Bot online but Telegram silent | Wrong `TELEGRAM_BOT_TOKEN` in the restored `.env`, or the token was revoked — check `zedbot logs bot` |
| HTTPS probe fails | DNS not yet pointing at the new server, or certbot rate-limited — `zedbot https-status` for details |

## What this procedure cannot recover

- Anything newer than the last backup (backups are point-in-time; run
  scheduled backups + off-server copies to bound the loss window).
- Encrypted backups whose password was lost — by design, there is no
  recovery path.
- Redis state (queues, heartbeats, aggregation counters) — deliberately
  ephemeral; it rebuilds itself.
