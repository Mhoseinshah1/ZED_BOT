# ZED_BOT

Production-ready Telegram VPN sales bot.

> **Current status:** this repository contains the **installation
> infrastructure and the core development foundation** — one-command
> install/update/backup/restore with the `zedbot` CLI, plus a real TypeScript
> monorepo: Fastify API with database/Redis health checks, grammY Telegram
> bot (`/start`, `/ping`), BullMQ worker, and a Prisma database layer with
> initial models, migrations and seeding. The actual bot features (products,
> payments, panel integrations, menus, admin panel) land in later iterations.

## Stack

- TypeScript / Node.js (pnpm workspaces monorepo)
- Fastify (HTTP API)
- grammY (Telegram bot)
- BullMQ (background jobs)
- PostgreSQL + Prisma
- Redis
- Docker Compose

## Requirements

- Ubuntu **24.04** or **26.04** (primary supported versions; Ubuntu 22.04 may work on a best-effort basis)
- Root access
- A **domain name** pointing at the server (IP-only setups are not supported)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (can be added later)

## Installation

Run as root on a fresh Ubuntu 24.04 / 26.04 server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
```

The installer:

1. Verifies the OS (primary: Ubuntu 24.04 / 26.04; Ubuntu 22.04 is accepted on a best-effort basis).
2. Installs base dependencies (curl, git, ca-certificates, gnupg, lsb-release, jq, unzip, zip, openssl, ufw — ufw is only installed, never enabled or reconfigured).
3. Installs Docker Engine and the Docker Compose plugin if missing.
4. Creates the directory layout:

   | Path                  | Purpose                                |
   | --------------------- | -------------------------------------- |
   | `/opt/zedbot/app`     | Application code (this repository)     |
   | `/opt/zedbot/data`    | Persistent data (PostgreSQL, Redis)    |
   | `/opt/zedbot/backups` | Backup archives                        |
   | `/opt/zedbot/logs`    | Log files (reserved for later phases)  |

5. Clones this repository into `/opt/zedbot/app` (or updates it when already present).
6. Interactively creates `/opt/zedbot/app/.env` (existing configurations are kept unless you choose otherwise). It asks for the Telegram bot token, the main admin Telegram ID, the **domain name** and the SSL email (default `admin@<domain>`), and auto-generates `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_SECRET`, `INTERNAL_API_TOKEN` and `BACKUP_ENCRYPTION_PASSWORD`. The file is written with `chmod 600` and secrets are never printed.
7. Installs the `zedbot` CLI to `/usr/local/bin/zedbot`.
8. Builds and starts all services with Docker Compose.
9. Applies database migrations (`prisma migrate deploy`) and seeds baseline
   data: the Telegram IDs from `ADMIN_TELEGRAM_IDS` become `OWNER` admins and
   the default settings are created.
10. Runs the health checks and prints a summary.

The installer is **idempotent** — re-running it on an installed server is safe:
existing `.env`, data and backups are preserved by default.

## Server management

All management goes through the `zedbot` CLI (run as root):

| Command                        | Description                                             |
| ------------------------------ | ------------------------------------------------------- |
| `zedbot status`                | Show the status of all services                         |
| `zedbot doctor`                | Run system health checks (pass/fail table)              |
| `zedbot logs`                  | Tail logs for all services                              |
| `zedbot logs api`              | Tail logs for the API service only                      |
| `zedbot logs bot`              | Tail logs for the bot service only                      |
| `zedbot logs worker`           | Tail logs for the worker service only                   |
| `zedbot restart`               | Restart all services                                    |
| `zedbot start`                 | Start all services                                      |
| `zedbot stop`                  | Stop all services                                       |
| `zedbot update`                | Update to the latest version (creates a backup first)   |
| `zedbot backup`                | Create a database backup (`zedbot-db-YYYYMMDD-HHMMSS.sql.gz`) |
| `zedbot health`                | Quick health summary (services, database, disk)         |
| `zedbot ps`                    | Alias of `zedbot status`                                 |
| `zedbot shell [service]`       | Open a shell inside a container (default: bot)           |
| `zedbot env-check`             | Validate `.env` (prints key names + OK/MISSING/INVALID only) |
| `zedbot restore-help`          | Print MANUAL restore instructions (executes nothing)     |
| `zedbot help`                  | Show usage                                              |

### Update

```bash
zedbot update
```

Creates a safety backup, pulls the latest code, rebuilds the images, restarts
the services, runs migrations (when available) and finishes with health
checks.

### Status and health

```bash
zedbot status
zedbot doctor
```

`zedbot doctor` checks the OS, Docker, Compose, the app files, the containers,
PostgreSQL/Redis connectivity and the API health endpoint, and prints a clear
pass/fail table.

### Logs

```bash
zedbot logs
zedbot logs api
zedbot logs bot
zedbot logs worker
```

### Backup and restore

```bash
zedbot backup                     # database backup: zedbot-db-YYYYMMDD-HHMMSS.sql.gz
zedbot restore-help               # prints the MANUAL restore steps (executes nothing)
```

`zedbot backup` writes a database-only dump to `/opt/zedbot/backups` as
`zedbot-db-YYYYMMDD-HHMMSS.sql.gz` — the same format the in-bot admin backup
page (Phase 35) creates and lists, so both appear together. It never
includes `.env`. When `BACKUP_RETENTION_DAYS` is set to a positive number,
matching `zedbot-db-*.sql.gz` files older than that many days are removed
after a successful backup; nothing else is ever deleted. (`zedbot update`
additionally creates a `.env`+database safety archive via `scripts/backup.sh`
before updating.)

**Restore is intentionally manual.** Neither the bot nor the CLI executes a
restore — `zedbot restore-help` prints the exact server commands
(stop the app services, `gunzip -c … | docker compose exec -T postgres
psql …`, start again) with placeholders you fill from `.env`. Always take a
fresh backup first.

### Start / stop / restart

```bash
zedbot restart
zedbot stop
zedbot start
```

### Restore

Restore is **manual and instructions-only** — neither the bot nor the CLI
ever executes a restore. Run `zedbot restore-help` for the exact server
commands, and always take a fresh `zedbot backup` first.

## Services

`docker-compose.yml` defines:

| Service    | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `postgres` | PostgreSQL 16 (data in `/opt/zedbot/data/postgres`)                |
| `redis`    | Redis 7, password-protected, AOF persistence                       |
| `api`      | Fastify API — `GET /health` (db + redis checks) and `GET /version` |
| `bot`      | grammY Telegram bot (long polling) — `/start`, `/ping`             |
| `worker`   | BullMQ worker on the `default` queue                               |

`api`, `bot` and `worker` share one image built from the root `Dockerfile`;
only the start command differs per service.

`GET /health` returns `200` when everything is reachable:

```json
{ "ok": true, "service": "api", "database": "ok", "redis": "ok" }
```

and `503` with `"ok": false` plus error details when the database or Redis is
down. `GET /version` returns the app name, package version and `NODE_ENV`.

## Configuration

All configuration lives in `/opt/zedbot/app/.env` (created by the installer,
`chmod 600`). See [`.env.example`](.env.example) for the full list of keys:

| Key                                   | Default                | Description                            |
| ------------------------------------- | ---------------------- | -------------------------------------- |
| `NODE_ENV`                             | `production`           | Node environment                       |
| `APP_NAME`                             | `ZED_BOT`              | Application name                       |
| `APP_DOMAIN`                           | —                      | Domain name of the server (required)   |
| `APP_BASE_URL`                         | `https://<APP_DOMAIN>` | Public base URL                        |
| `API_PORT`                             | `3000`                 | Published API port                     |
| `LOG_LEVEL`                            | `info`                 | `debug` / `info` / `warn` / `error`    |
| `SSL_EMAIL`                            | `admin@<APP_DOMAIN>`   | Email for SSL certificates (later phase) |
| `TELEGRAM_BOT_TOKEN`                   | —                      | Bot token from @BotFather              |
| `ADMIN_TELEGRAM_IDS`                   | —                      | Comma-separated admin Telegram IDs     |
| `POSTGRES_DB` / `POSTGRES_USER`        | `zedbot`               | Database name / user                   |
| `POSTGRES_PASSWORD`                    | auto-generated         | Database password                      |
| `DATABASE_URL`                         | auto-generated         | PostgreSQL connection URL              |
| `REDIS_HOST` / `REDIS_PORT`            | `redis` / `6379`       | Redis host / port (inside Compose)     |
| `REDIS_PASSWORD`                       | auto-generated         | Redis password                         |
| `REDIS_URL`                            | auto-generated         | Redis connection URL                   |
| `APP_SECRET`                           | auto-generated         | Application signing/crypto secret      |
| `INTERNAL_API_TOKEN`                   | auto-generated         | Token for internal service-to-service calls |
| `BACKUP_DIR`                           | `/opt/zedbot/backups`  | Where backup archives are written      |
| `BACKUP_ENCRYPTION_PASSWORD`           | auto-generated         | Backup encryption password (empty = unencrypted) |

After editing `.env`, apply the changes with `zedbot restart`.

## Domain and SSL

ZED_BOT requires a **domain name** — the installer asks for it and stores
`APP_DOMAIN` and `APP_BASE_URL=https://<domain>` in `.env`, along with an
`SSL_EMAIL` (default `admin@<domain>`) for future certificates. IP-only mode
is intentionally not supported.

**HTTPS (Phase 37):** once the domain's DNS A record points at the server,
enable the reverse proxy and certificate with:

```bash
zedbot nginx          # Nginx reverse proxy for APP_DOMAIN -> 127.0.0.1:API_PORT
zedbot ssl            # Let's Encrypt certificate (webroot) + HTTPS config
zedbot https-status   # Nginx/cert status + probe https://<domain>/health
zedbot renew-cert     # force a renewal check (certbot's systemd timer renews automatically)
zedbot firewall       # safe ufw setup - SSH is allowed BEFORE enabling (Phase 38)
zedbot security       # read-only security audit (run it after HTTPS is up)
```

The API container binds to `127.0.0.1:<API_PORT>` only — the public
entrypoint is Nginx on ports 80/443 (80 redirects to HTTPS except the ACME
path). PostgreSQL and Redis remain unexposed. See
`docs/production-https-phase37.md`.

## Phase 1 limitations

This phase delivers infrastructure and the application skeleton only. Not
implemented yet, by design:

- Telegram menus, purchase flows and any bot business logic (the bot only
  answers `/start` with a placeholder message and `/ping` with `pong`)
- Products, orders, services, users management, payments
- Admin panel, reseller system, mini app

Panel integrations have since been implemented (see
`packages/panel-adapters` and `docs/panel-capabilities.md`):

- **Marzban** (and RickPanelAPI-compatible panels exposing the same
  documented contract): authenticated provisioning, read/sync, renewal,
  extra volume/time, enable/disable, subscription regeneration,
  reconciliation — `docs/marzban-provisioning.md`
- **XUI / Sanaei 3X-UI** (SANAEI variant, global client API - one
  first-class client per service attached to all configured inbounds;
  pinned upstream contract in `docs/xui-provisioning.md`): authenticated
  provisioning, read/sync, renewal, extra volume/time, enable/disable,
  subscription regeneration (subId re-key) and reconciliation, with two
  explicit authentication modes (SESSION_COOKIE username/password login
  and API_TOKEN bearer token). Lifecycle mutations apply only to
  GLOBAL_CLIENT services; legacy per-inbound services stay readable and
  are blocked before payment. Panel versions without the global client
  API are detected and blocked as unsupported —
  `docs/xui-global-client-lifecycle.md`

Remote identities are resolved by the admin-selected per-panel naming
strategy (eight strategies, immutable per-order snapshots, deterministic
retries/reconciliation) — `docs/service-naming-strategies.md`,
`docs/provisioning-idempotency.md`. OTHER_PRODUCT orders get safe
deterministic delivery references — `docs/other-product-naming.md`.

### Persian bot copy

All Telegram-visible user and admin texts are Persian and aligned with the
master requirements document (`docs/persian-text-alignment.md`). Reusable
copy lives in operator-editable `MessageTemplate`/`ButtonText` rows whose
defaults come from a single registry (`packages/database/src/seed-data.ts`;
see `docs/text-system.md`, `docs/message-template-registry.md`,
`docs/button-text-registry.md`). Template edits are validated against an
explicit per-template variable list; secret-shaped variables can never be
rendered. Callback data never derives from button labels.

## Development foundation

### Project structure

pnpm workspaces monorepo:

```
.
├── apps/
│   ├── api/              # Fastify API — GET /health, GET /version
│   ├── bot/              # grammY Telegram bot — /start, /ping
│   └── worker/           # BullMQ worker — "default" queue
├── packages/
│   ├── shared/           # Env validation, logger, constants (APP_NAME)
│   ├── database/         # Prisma schema, client singleton, migrations, seed
│   ├── panel-adapters/   # VPN panel adapter interface (placeholder)
│   └── payments/         # Online payment gateways (Zarinpal, NOWPayments, Stars)
├── scripts/
│   ├── install.sh        # One-command installer (self-contained)
│   ├── update.sh         # Updater (backup → pull → rebuild → doctor)
│   ├── migrate.sh        # prisma migrate deploy + seed (run by install/update)
│   ├── backup.sh         # Update safety archive (.env + PostgreSQL dump)
│   ├── backup-db.sh      # Database backup (zedbot-db-YYYYMMDD-HHMMSS.sql.gz)
│   ├── validate-env.sh   # .env validation (never prints values)
│   ├── doctor.sh         # Health checks
│   ├── zedbot.sh         # Management CLI (installed to /usr/local/bin/zedbot)
│   ├── zedbot            # Compatibility wrapper for zedbot.sh
│   └── lib/common.sh     # Shared shell helpers
├── Dockerfile            # Shared image for api / bot / worker
├── docker-compose.yml
└── .env.example
```

### Running the services

On a server, everything runs through Docker Compose (`zedbot start`,
`zedbot status`, `zedbot logs api|bot|worker`). By hand:

```bash
docker compose up -d --build
docker compose ps
docker compose logs api
```

For local development (Node >= 20, `npm i -g pnpm`):

```bash
pnpm install
pnpm db:generate         # generate the Prisma client
pnpm build               # build all workspace packages
pnpm dev:api             # or dev:bot / dev:worker (tsx watch)
```

The dev processes read the same environment variables as the containers
(`DATABASE_URL`, `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`,
`TELEGRAM_BOT_TOKEN`, `API_PORT`).

### Database schema

The full Prisma schema (users, wallet ledger, panels, products, checkout,
orders, payments, services, referrals, support, tutorials, broadcasts,
logging) is documented in
[`docs/database-schema.md`](docs/database-schema.md) — including the money
rules (toman as `Int`, bytes as `BigInt`), the snapshot strategy, and why a
`CheckoutSession` exists before any `Order`.

### Online payments

The Zarinpal / NOWPayments / Telegram Stars gateway system (`@zedbot/payments`
plus the bot settlement service and the API webhook routes, with the
`ZARINPAL_*`, `NOWPAYMENTS_*` and `TELEGRAM_STARS_ENABLED` variables from
`.env.example`) is documented in
[`docs/payment-architecture.md`](docs/payment-architecture.md), with
per-provider details in [`docs/zarinpal.md`](docs/zarinpal.md),
[`docs/nowpayments.md`](docs/nowpayments.md),
[`docs/telegram-stars.md`](docs/telegram-stars.md) and the end-to-end state
machine in [`docs/payment-lifecycle.md`](docs/payment-lifecycle.md).

Settlement is atomic across providers: each checkout has exactly one
settlement owner (`CheckoutSession.settledByPaymentId`, DB-enforced), so two
provider successes can never both settle one pre-invoice — the second
success is filed for financial review instead of double-charging or getting
stuck. The design, crash windows and idempotency rules are documented in
[`docs/cross-provider-checkout-settlement.md`](docs/cross-provider-checkout-settlement.md),
with the review queue and migration audit queries in
[`docs/financial-reconciliation.md`](docs/financial-reconciliation.md) and
the DB-enforced invariants in
[`docs/database-invariants.md`](docs/database-invariants.md).

### Database migrations

Migrations live in `packages/database/prisma/migrations` and are applied
automatically by the installer and `zedbot update` (via `scripts/migrate.sh`).
Manually:

```bash
bash /opt/zedbot/app/scripts/migrate.sh     # on a server (migrate + seed)
pnpm db:deploy                              # local: prisma migrate deploy
pnpm db:migrate                             # local dev: prisma migrate dev
```

### Seeding admins

The seed reads `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user IDs) from
the environment, upserts each as an `OWNER` admin, and creates the default
settings (`bot_name`, `maintenance_mode`, `support_username`,
`force_join_enabled`) without overwriting values you have changed. It runs
automatically with `scripts/migrate.sh`; manually: `pnpm db:seed`.

### Checking health

```bash
curl http://localhost:3000/health    # {"ok":true,"service":"api","database":"ok","redis":"ok"}
curl http://localhost:3000/version   # {"app":"ZED_BOT","version":"0.1.0","environment":"production"}
zedbot doctor
```

### Trying the bot

With a valid `TELEGRAM_BOT_TOKEN` in `.env` and the services running, open
your bot in Telegram:

- `/start` — replies with a placeholder message confirming the installation
  works. As **temporary Phase 1 smoke-test behaviour** it also
  registers/updates your user record (username, name, language, last-seen)
  to prove the bot → database path; the real registration flow replaces this
  in a later phase.
- `/ping` — replies `pong`.

Menus, purchases and admin commands arrive in the next steps.

### Troubleshooting the monorepo

`@zedbot/database`, `@zedbot/shared`, `@zedbot/panel-adapters` and
`@zedbot/payments` are **pnpm workspace packages**: the apps resolve them
through each package's `main`/`types`/`exports` fields, which point at the
compiled `dist/` output. Nothing resolves from `src/` directly, so on a fresh
checkout the packages must be built once before the apps can typecheck.

The root scripts handle the ordering for you:

```bash
pnpm install
pnpm db:generate     # Prisma client (needed by @zedbot/database types)
pnpm typecheck       # builds packages/* first, then typechecks everything
pnpm build           # builds all packages and apps in dependency order
```

CI runs exactly this sequence. If you see
`error TS2307: Cannot find module '@zedbot/...'`, it means the workspace
packages have not been built yet — run `pnpm db:generate && pnpm build` (or
`pnpm typecheck`, which pre-builds `packages/*` itself). If types from
`@prisma/client` are missing, run `pnpm db:generate`.

## CI

Every push and pull request to `main` is checked by GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)); the workflow can
also be started manually for any branch from the Actions tab
(`workflow_dispatch`). Since development happens through GitHub / Claude Code
rather than on a local server, CI is the safety net that validates every
change before it lands.

The workflow runs on an Ubuntu runner with dummy credentials (no real tokens
or passwords) and validates:

- **TypeScript** — `pnpm typecheck` and `pnpm lint` across the workspace
- **Build** — `pnpm build` for every app and package
- **Prisma** — client generation, plus `migrate deploy` and the seed against
  a real PostgreSQL 16 service container (asserts the OWNER admin and default
  settings exist)
- **Runtime smoke test** — boots the API against PostgreSQL and
  password-protected Redis and asserts `GET /health` returns
  `"ok":true` with `database`/`redis` both `"ok"`
- **Docker Compose** — `docker compose config` against a CI-generated `.env`
- **Shell scripts** — `bash -n` syntax checks and ShellCheck for all
  installer/management scripts

## Security notes

- `.env` is created with `chmod 600` and is never committed (see `.gitignore`).
- The scripts never print `TELEGRAM_BOT_TOKEN`, `POSTGRES_PASSWORD` or
  `REDIS_PASSWORD`; secret prompts use hidden input.
- PostgreSQL and Redis are **not** published on host ports — they are only
  reachable on the internal Docker network.
- Backup archives contain credentials and are written with `chmod 600`.
- Restore execution and uninstall are intentionally NOT part of the CLI;
  restore is manual (`zedbot restore-help` prints the steps).
