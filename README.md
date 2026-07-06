# ZED_BOT

Production-ready Telegram VPN sales bot.

> **Current status:** this repository contains the **installation and
> infrastructure foundation** — one-command install, updates, backups,
> restore, health checks and a `zedbot` management CLI on top of Docker
> Compose. The API, bot and worker services are minimal placeholders; the
> actual bot features (products, payments, panel integrations, admin panel)
> land in later iterations.

## Stack

- TypeScript / Node.js
- PostgreSQL
- Redis
- Docker Compose

## Requirements

- Ubuntu **22.04** or **24.04**
- Root access
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (can be added later)

## Installation

Run as root on a fresh Ubuntu 22.04 / 24.04 server:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
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
9. Runs database migrations when a migration command exists (none yet).
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

| Service    | Description                                             |
| ---------- | ------------------------------------------------------- |
| `postgres` | PostgreSQL 16 (data in `/opt/zedbot/data/postgres`)     |
| `redis`    | Redis 7, password-protected, AOF persistence            |
| `api`      | HTTP API placeholder — exposes `GET /health`            |
| `bot`      | Telegram bot placeholder (logs a startup message)       |
| `worker`   | Background worker placeholder (logs a startup message)  |

The API health endpoint returns:

```json
{ "ok": true, "service": "api" }
```

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

## Project structure

```
.
├── apps/
│   ├── api/              # HTTP API service (placeholder, GET /health)
│   ├── bot/              # Telegram bot service (placeholder)
│   └── worker/           # Background worker service (placeholder)
├── packages/
│   ├── shared/           # Shared types/constants (placeholder)
│   ├── database/         # Database layer & migrations (placeholder)
│   ├── panel-adapters/   # VPN panel integrations (placeholder)
│   └── payments/         # Payment gateway integrations (placeholder)
├── scripts/
│   ├── install.sh        # One-command installer (self-contained)
│   ├── update.sh         # Updater (backup → pull → rebuild → doctor)
│   ├── backup.sh         # Backup (.env + PostgreSQL dump)
│   ├── restore.sh        # Restore from a backup archive
│   ├── doctor.sh         # Health checks
│   ├── uninstall.sh      # Uninstaller
│   ├── zedbot            # Management CLI (installed to /usr/local/bin)
│   └── lib/common.sh     # Shared shell helpers
├── docker-compose.yml
└── .env.example
```

## Security notes

- `.env` is created with `chmod 600` and is never committed (see `.gitignore`).
- The scripts never print `TELEGRAM_BOT_TOKEN`, `POSTGRES_PASSWORD` or
  `REDIS_PASSWORD`; secret prompts use hidden input.
- PostgreSQL and Redis are **not** published on host ports — they are only
  reachable on the internal Docker network.
- Backup archives contain credentials and are written with `chmod 600`.
- Destructive actions (restore, uninstall, data deletion) always ask for
  confirmation.
