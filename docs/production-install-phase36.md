# ZED_BOT production install and server CLI (Phase 36)

Phase 36 covers the server-side install/operations tooling under `scripts/`:
the one-command installer, the `zedbot` management CLI, `.env` validation
and database backups. **Restore execution is intentionally not implemented**
— from the CLI or from Telegram — restore is manual, instructions only.
There is **no uninstall command**. Nothing here touches
payment/order/service/support/broadcast logic.

> **Ops-phase update (production backups + Telegram logging):** the backup
> format, directory permissions and several CLI commands described below
> were reworked after Phase 36 — see the
> [Ops-phase changes](#ops-phase-changes-production-backup-rework) section
> at the end of this document and
> [backup-architecture.md](backup-architecture.md) for the current design.
> Where the two disagree, the ops-phase section wins.

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
`stop`, `update`, `deploy-status`, `rollback-status`, `rollback [--yes]`, `backup`, `health`, `doctor`,
`shell [service]`, `env-check`, `restore-help` — plus, from later phases, the Phase 37 HTTPS
commands (`nginx`, `ssl`, `renew-cert`, `https-status`) and the Phase 38
hardening commands (`firewall`, `security`; run `zedbot security` after
enabling HTTPS — see `docs/production-security-phase38.md`). `help` and `restore-help` work even before
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
  (default `/opt/zedbot/app/.env`). Checks: the Telegram token matches the
  runtime resolver exactly — `TELEGRAM_BOT_TOKEN` (canonical) or `BOT_TOKEN`
  (legacy fallback, warns) present; both-equal warns (duplicate key); both set
  to DIFFERENT values FAILS with «TELEGRAM_BOT_TOKEN and BOT_TOKEN conflict»
  (see `docs/telegram-bot-token.md`); `ADMIN_TELEGRAM_IDS` or `OWNER_TELEGRAM_ID` present
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

Restore execution (CLI or Telegram), uninstall, cloud upload, migration
runner from Telegram, `.env` editing from Telegram, destructive database
reset, web panel, mini app, Phase 37+. (Scheduled backups have since been
implemented in the ops phase — worker-side, see below.)

## Ops-phase changes (production-backup rework)

The production-backup + Telegram-logging overhaul updated the server
tooling documented above. Current state:

### Directories and permissions

- The host backup directory (`ZEDBOT_BACKUP_DIR`, default
  `/opt/zedbot/backups`) is bind-mounted into the **bot read-only** and the
  **worker read-write** at `/var/lib/zedbot/backups`, and must be owned by
  the container runtime user — **`ZEDBOT_RUNTIME_UID:ZEDBOT_RUNTIME_GID`
  (default `1000:1000`, the image's `node` user) with mode 750**.
- The installer now chowns/chmods it accordingly (`create_directories`),
  and the shared helper `ensure_backup_dir_permissions` (lib/common.sh)
  repairs it idempotently: `mkdir -p` + `chown` + `chmod 750`, plus
  normalizing `zedbot-db-*` files to `640` — it never deletes anything and
  never widens beyond 750. Update safety archives (`zedbot_backup_*.tar.gz`)
  stay root-owned 600.

### New/changed `.env` keys

`ZEDBOT_BACKUP_DIR` (HOST dir), `BACKUP_DIR` (IN-CONTAINER path — pinned by
compose, leave empty in `.env`; it does **not** relocate host backups),
`ZEDBOT_RUNTIME_UID` / `ZEDBOT_RUNTIME_GID`, `BACKUP_RETENTION_DAYS` (14),
`BACKUP_MIN_RETAINED` (3), `BACKUP_MIN_FREE_DISK_MB` (500),
`BACKUP_MAX_TELEGRAM_MB` (45), `BACKUP_ENCRYPTION_PASSWORD`
(installer-generated; keep a copy off-server — see
[backup-encryption.md](backup-encryption.md)).

### CLI changes

- **`zedbot backup [create]`** now produces the queue-parity format:
  `zedbot-db-YYYYMMDD-HHMMSS.dump[.enc]` (pg_dump `--format=custom`,
  verified with `pg_restore --list`, optionally ZBK1-encrypted via the
  worker's encrypt CLI, atomic `.partial` → rename, sha256 + sidecar
  `.manifest.json`). `ZEDBOT_BACKUP_FORMAT=legacy` still writes the old
  `.sql.gz`.
- **`zedbot backup list`** — name, size, date, type, verified-flag table
  over all three formats.
- **`zedbot backup verify <file|path|timestamp>`** — sha256 vs manifest,
  then per-format structural verification (worker CLI for `.dump.enc`).
- **`zedbot repair backups`** — runs `ensure_backup_dir_permissions`, then
  live-tests worker rw / bot ro access through the running containers
  (and warns if the bot mount is unexpectedly writable).
- **`zedbot doctor`** gained backup-dir checks (exists / owner
  `1000:1000` / mode ≤ 750); **`zedbot doctor --fix`** additionally runs the
  permission repair — everything else in the doctor stays read-only.
- **`zedbot update`** now has a hard **pre-update backup gate**: a database
  backup is created AND verified before any code is touched, otherwise the
  update aborts with the running installation unmodified. Escape hatch
  (CLI-only, not recommended): `ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot
  update`. `update.sh` also auto-repairs the backup-dir permissions before
  the gate.
- **`zedbot update` is now a 14-step fail-closed, self-healing flow** (legacy-upgrade
  phase): safety archive → verified pre-update backup → pull → append-only
  `.env` migration → installed-CLI refresh (a refresh failure aborts) →
  image build with the `GIT_SHA` deployment identity → migrations
  (`migrate.sh`) → `up -d --force-recreate --remove-orphans` →
  deployed-SHA recording → post-deploy smoke test (a real verified backup
  through the running worker; failure keeps the app running but exits
  non-zero) → doctor. Step list, smoke categories and recovery commands:
  [legacy-upgrade.md](legacy-upgrade.md).
- **Application rollback:** `zedbot rollback-status` validates the retained
  candidate; `zedbot rollback [--yes]` restores only API/Bot/Worker with
  `--no-deps --no-build`. Update and rollback share a deployment lock.
  PostgreSQL, Redis and database data are never rolled back. See
  [deployment-rollback.md](deployment-rollback.md).
- **`zedbot deploy-status`** — read-only report of repository/image/
  container version alignment (repo HEAD vs installed CLI vs each
  container's baked `GIT_SHA`) plus the database migration status via the
  worker `migration-status` CLI. Always exits 0; degrades to
  `unavailable` with containers down; never prints env values. Sample
  output and interpretation: [legacy-upgrade.md](legacy-upgrade.md).
- **`zedbot doctor`** also reports the installed-CLI freshness and one
  deployment-identity row per app container (`bot|worker GIT_SHA matches
  repo HEAD`); **`zedbot doctor --fix`** additionally refreshes a stale
  installed CLI.
- **Legacy upgrades self-heal.** Installations that predate PR #92 (old
  containers/CLI/.env after `zedbot update`) converge automatically: the
  old updater executes the new `scripts/migrate.sh`, whose
  `legacy_self_heal` migrates the `.env` (append-only), refreshes the CLI,
  rebuilds with identity and force-recreates the containers. Full design,
  trigger conditions and guarantees: [legacy-upgrade.md](legacy-upgrade.md).
- **`zedbot restore-help`** was updated for all three formats (still
  instructions-only). The full procedure lives in
  [backup-restore-runbook.md](backup-restore-runbook.md).

### Related documentation

[backup-architecture.md](backup-architecture.md) (queue, state machine,
retention, scheduled backups), [legacy-upgrade.md](legacy-upgrade.md)
(self-healing updater, deployment identity, deploy-status, post-deploy
smoke), [backup-encryption.md](backup-encryption.md),
[backup-disaster-recovery.md](backup-disaster-recovery.md),
[worker-queues.md](worker-queues.md), [system-health.md](system-health.md),
[operational-logging.md](operational-logging.md),
[telegram-log-group.md](telegram-log-group.md).
