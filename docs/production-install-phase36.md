# ZED_BOT production install and server CLI (Phase 36)

Phase 36 covers the server-side install/operations tooling under `scripts/`:
the one-command installer, the `zedbot` management CLI, `.env` validation
and database backups. **Restore execution is intentionally not implemented**
— from the CLI or from Telegram — restore is manual, instructions only.
There is **no uninstall command**. Nothing here touches
payment/order/service/support/broadcast logic.

## Scripts

| file | purpose |
| --- | --- |
| `scripts/install.sh` | self-contained installer (`/opt/zedbot`, Docker, `.env`, CLI, services) |
| `scripts/zedbot.sh` | **canonical management CLI** — installed to `/usr/local/bin/zedbot` |
| `scripts/zedbot` | thin compatibility wrapper that execs `zedbot.sh` |
| `scripts/validate-env.sh` | `.env` validation used by `zedbot env-check` |
| `scripts/backup-db.sh` | database backup used by `zedbot backup` |
| `scripts/backup.sh` | `.env`+database safety archive used internally by `zedbot update` |
| `scripts/update.sh` / `doctor.sh` / `migrate.sh` | updater, health checks, migrations |
| `scripts/lib/common.sh` | shared helpers |

Static check (all must pass):

```bash
bash -n scripts/install.sh
bash -n scripts/zedbot.sh
bash -n scripts/validate-env.sh
bash -n scripts/backup-db.sh
```

## zedbot CLI commands

`help`, `status`, `ps` (alias), `logs [service]`, `restart`, `start`,
`stop`, `update`, `backup`, `health`, `doctor`, `shell [service]`,
`env-check`, `restore-help`. `help` and `restore-help` work even before
installation (they print and exit); everything else requires the installed
app directory and root.

- **`zedbot backup`** runs `scripts/backup-db.sh`: creates
  `/opt/zedbot/backups` if missing and writes
  **`zedbot-db-YYYYMMDD-HHMMSS.sql.gz`** — the exact Phase 35 in-bot format,
  so CLI backups appear in the bot's admin backup list too. The dump runs as
  `docker compose exec -T postgres pg_dump …` piped through gzip: no
  password is echoed (pg_dump runs inside the container over the local
  socket), `.env` is **never** part of this file, an empty/failed dump
  deletes the partial file, and a same-second re-run never overwrites an
  existing backup. Optional retention: a positive `BACKUP_RETENTION_DAYS`
  removes only matching `zedbot-db-*.sql.gz` files older than that many
  days after a successful backup.
- **`zedbot env-check`** runs `scripts/validate-env.sh [env-file]`
  (default `/opt/zedbot/app/.env`). Checks: `TELEGRAM_BOT_TOKEN` or
  `BOT_TOKEN` present; `ADMIN_TELEGRAM_IDS` or `OWNER_TELEGRAM_ID` present
  and numeric/comma-numeric; `APP_SECRET` ≥ 32 chars; `DATABASE_URL`
  present; `REDIS_URL` or `REDIS_HOST` present; `NODE_ENV=production`;
  `BACKUP_DIR` present or defaultable. Output is **key names +
  OK/MISSING/INVALID only — values and secrets are never printed**, and the
  file is parsed (never sourced), so nothing in it can execute. Exits
  non-zero on any problem.
- **`zedbot restore` / `zedbot restore-help`** print the manual restore
  steps and exit **without changing anything**: take a fresh backup, stop
  the app services, `gunzip -c <file> | docker compose exec -T postgres
  psql -U <POSTGRES_USER> -d <POSTGRES_DB>`, start again — placeholders are
  filled from the server's `.env` by the operator.
- **`zedbot health`** is a quick summary (compose ps, `pg_isready`, backup
  disk usage); **`zedbot doctor`** runs the full check suite.

## install.sh

Installs the CLI with `install -m 0755 scripts/zedbot.sh
/usr/local/bin/zedbot` (the `scripts/zedbot` wrapper stays for
compatibility), `chmod +x`'s all scripts, and the final summary points at
`zedbot status`, `zedbot logs`, `zedbot doctor`, `zedbot backup` and
`zedbot env-check`.

## Security

Root required for operational commands; `.env` is chmod 600 and never
printed (validation reports key names only); no destructive
restore/uninstall/database-reset commands exist; retention cleanup touches
only `zedbot-db-*.sql.gz`; secrets never appear on command lines or in
logs.

## Testing

`apps/bot/tests/deploy-scripts.test.ts` (no DB needed): `bash -n` over the
four required scripts; `validate-env.sh` against valid / missing / invalid
temp `.env` files asserting exit codes, key-name output and that **secret
values never appear in the output**; `zedbot help` exposing no
uninstall/destructive-restore command while listing every required command;
`zedbot restore` printing instructions only (exit 0, no side effects); and
the `backup-db.sh` filename matching the Phase 35 pattern (cross-checked
against the bot's own `isBackupFileName`).

## Intentionally NOT implemented

Restore execution (CLI or Telegram), uninstall, scheduled backups, cloud
upload, migration runner from Telegram, `.env` editing from Telegram,
destructive database reset, web panel, mini app, Phase 37+.
