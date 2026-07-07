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

- Ubuntu **22.04** or **24.04**
- Root access
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (can be added later)

## Installation

Run as root on a fresh Ubuntu 22.04 / 24.04 server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
```

The installer:

1. Verifies the OS (Ubuntu 22.04 / 24.04).
2. Installs base dependencies (curl, git, ca-certificates, gnupg, lsb-release, openssl).
3. Installs Docker Engine and the Docker Compose plugin if missing.
4. Creates the directory layout:

   | Path                  | Purpose                                |
   | --------------------- | -------------------------------------- |
   | `/opt/zedbot/app`     | Application code (this repository)     |
   | `/opt/zedbot/data`    | Persistent data (PostgreSQL, Redis)    |
   | `/opt/zedbot/backups` | Backup archives                        |

5. Clones this repository into `/opt/zedbot/app` (or updates it when already present).
6. Interactively creates `/opt/zedbot/app/.env` (existing configurations are kept unless you choose otherwise). Empty database/Redis passwords are auto-generated. The file is written with `chmod 600` and secrets are never printed.
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
| `zedbot backup`                | Create a backup (`.env` + PostgreSQL dump)              |
| `zedbot restore <backup-file>` | Restore from a backup archive (asks for confirmation)   |
| `zedbot uninstall`             | Remove ZED_BOT (data/backups kept unless confirmed)     |
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
zedbot backup
zedbot restore /opt/zedbot/backups/zedbot-backup-20260101-120000.tar.gz
```

Backups are written to `/opt/zedbot/backups` as
`zedbot-backup-YYYYMMDD-HHMMSS.tar.gz` and contain the `.env` configuration
and a full PostgreSQL dump. Restore is destructive and asks for confirmation;
the replaced `.env` is kept next to the restored one.

### Start / stop / restart

```bash
zedbot restart
zedbot stop
zedbot start
```

### Uninstall

```bash
zedbot uninstall
```

Stops the services and removes the CLI. Data, backups and the application
code are **kept by default** and only deleted when you explicitly confirm.

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
| `APP_DOMAIN_OR_IP`                     | —                      | Public domain or IP of the server      |
| `API_PORT`                             | `3000`                 | Published API port                     |
| `TELEGRAM_BOT_TOKEN`                   | —                      | Bot token from @BotFather              |
| `ADMIN_TELEGRAM_IDS`                   | —                      | Comma-separated admin Telegram IDs     |
| `POSTGRES_DB` / `POSTGRES_USER`        | `zedbot`               | Database name / user                   |
| `POSTGRES_PASSWORD`                    | auto-generated         | Database password                      |
| `DATABASE_URL`                         | auto-generated         | PostgreSQL connection URL              |
| `REDIS_HOST` / `REDIS_PORT`            | `redis` / `6379`       | Redis host / port (inside Compose)     |
| `REDIS_PASSWORD`                       | auto-generated         | Redis password                         |
| `REDIS_URL`                            | auto-generated         | Redis connection URL                   |

After editing `.env`, apply the changes with `zedbot restart`.

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
│   └── payments/         # Payment gateway interface (placeholder)
├── scripts/
│   ├── install.sh        # One-command installer (self-contained)
│   ├── update.sh         # Updater (backup → pull → rebuild → doctor)
│   ├── migrate.sh        # prisma migrate deploy + seed (run by install/update)
│   ├── backup.sh         # Backup (.env + PostgreSQL dump)
│   ├── restore.sh        # Restore from a backup archive
│   ├── doctor.sh         # Health checks
│   ├── uninstall.sh      # Uninstaller
│   ├── zedbot            # Management CLI (installed to /usr/local/bin)
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

- `/start` — registers/updates your user record (username, name, language,
  last-seen) and replies with a placeholder welcome message.
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
- Destructive actions (restore, uninstall, data deletion) always ask for
  confirmation.
