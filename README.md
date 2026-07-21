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
| `zedbot update`                | Update to the latest version (creates **and verifies** a backup first) |
| `zedbot deploy-status`         | Show repository/image/container version alignment and migration status |
| `zedbot backup`                | Create a verified database backup (`zedbot-db-YYYYMMDD-HHMMSS.dump[.enc]` + manifest) |
| `zedbot backup list`           | List all backups (name, size, date, type, verified)      |
| `zedbot backup verify <file>`  | Verify a backup by file name, path or timestamp id       |
| `zedbot repair backups`        | Fix backup directory ownership/permissions, test container access |
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

Creates and verifies a backup, pulls the latest code, migrates the `.env`
(append-only), refreshes the installed CLI, rebuilds the images with the
`GIT_SHA` deployment identity, runs migrations, force-recreates the
services, records the deployed version, runs a post-deploy smoke test and
finishes with health checks. Updates are **self-healing**: installations
that predate the persistent-backup layout (stale containers/CLI/`.env`
after an update) converge automatically, and `zedbot deploy-status` shows
whether repository, images, containers and migrations are aligned — see
`docs/legacy-upgrade.md`.

Installations that predate the persistent-backup release need one manual
command before their first update (the old updater cannot pull past the
mode-dirty tree its own installer created; the reason and details are in
`docs/legacy-upgrade.md`):

```bash
git -C /opt/zedbot/app config core.fileMode false && zedbot update
```

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

### Backups, system health and the Telegram log group

```bash
zedbot backup                     # verified backup: zedbot-db-YYYYMMDD-HHMMSS.dump[.enc] + manifest
zedbot backup list                # all backups: name, size, date, type, verified
zedbot backup verify <file|id>    # sha256 + structural verification (worker CLI for .dump.enc)
zedbot repair backups             # fix dir ownership/permissions (1000:1000, 750) + mount tests
zedbot restore-help               # prints the MANUAL restore steps (executes nothing)
```

**Backups** are `pg_dump --format=custom` dumps, verified with
`pg_restore --list`, written atomically (`.partial` → rename) into the
host directory `ZEDBOT_BACKUP_DIR` (default `/opt/zedbot/backups`) with a
non-secret `.manifest.json` sidecar, and — when
`BACKUP_ENCRYPTION_PASSWORD` is set (the installer generates one; **keep a
copy off the server**) — encrypted at rest with AES-256-GCM (the ZBK1
envelope). The directory is bind-mounted into the bot (**read-only**) and
the worker (**read-write**) at `/var/lib/zedbot/backups`; only the worker
service ever runs `pg_dump`. Admins manage everything from Telegram:
«گزارشات / بکاپ 🛡» offers manual backups, list/download/verify/delete,
retention cleanup and scheduled backups («تنظیمات بکاپ خودکار ⏰»);
retention keeps `BACKUP_MIN_RETAINED` newest files and never deletes the
newest or the newest verified backup. `zedbot update` refuses to run until
a fresh backup was created **and verified** (escape hatch:
`ZEDBOT_SKIP_PREUPDATE_BACKUP=1`). It never includes `.env` (the update's
separate safety archive does). Design: `docs/backup-architecture.md`,
`docs/backup-encryption.md`.

**System health** — «وضعیت سیستم 🩺» in the bot shows DB/Redis latency,
worker heartbeat, queue depth, backup-dir access (bot-read vs
worker-write), pg_dump presence, disk usage, the latest backup (with a
48-hour staleness warning), encryption and log-group state; `zedbot
doctor` covers the host side and `zedbot doctor --fix` repairs the backup
directory permissions. Line-by-line reference: `docs/system-health.md`.

**Telegram log group** — operational events (payments, orders, services,
panels, security, backups, audit) are delivered by the worker into an
operator-owned forum supergroup, one topic per category. **Recommended
setup: direct numeric chat-ID.** Build a private forum supergroup, add the
bot as admin with manage-topics, then from «تنظیمات عمومی ⚙️ → تنظیمات
گروه لاگ 📝» paste the group's `-100…` id — the bot validates it, and a
durable background operation creates the default topics, sends a test and
switches the group over atomically (the previous group stays active until
the new one is fully ready). `/setloggroup` inside the group and the
start-group wizard remain as fallbacks. Then manage topics/tests from the
same page. Setup guide: `docs/telegram-log-group.md`; pipeline:
`docs/operational-logging.md`.

**Restore is intentionally manual.** Neither the bot nor the CLI executes a
restore — `zedbot restore-help` prints the manual steps and the full
procedure (including `.dump.enc` decryption and disaster recovery) lives in
`docs/backup-restore-runbook.md` / `docs/backup-disaster-recovery.md`.
Always take a fresh backup first.

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
| `ZEDBOT_BACKUP_DIR`                    | `/opt/zedbot/backups`  | HOST backup directory (bind-mounted: bot ro, worker rw) |
| `BACKUP_DIR`                           | *(leave empty)*        | IN-CONTAINER backup path — pinned to `/var/lib/zedbot/backups` by compose |
| `BACKUP_ENCRYPTION_PASSWORD`           | auto-generated         | Backup encryption password (empty = unencrypted; keep a copy off-server) |

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

**Device connection guides** (disabled by default): an `آموزش اتصال 📱`
capability under every eligible Service with per-platform, operator-managed
"how to connect" pages for iPhone/iPad, Android, Windows, macOS, Linux and
Android TV. Third-party app names and **HTTPS-validated** download URLs are
managed by the OWNER (never hardcoded, never fetched); the guide reuses the
existing owner-scoped subscription/config text links and QR codes and never
embeds a Service secret in text, a URL button or a callback. Behind a master
switch + admin readiness gate — `docs/device-connection-guides.md`.

**Service self-diagnostics** (disabled by default): a `بررسی مشکل سرویس 🛠`
capability under every eligible Service. It diagnoses only what the bot can
authoritatively know (the Service row, its Panel, **one** bounded authenticated
panel account read, quota/expiry/status, payload availability, connection
timestamps and the current lifecycle actions), maps it to stable machine codes +
a deterministic overall severity, explains the likely problem in simple Persian
and routes the user to the correct **existing** action — it never repairs
anything automatically and never claims to inspect the customer's phone, ISP, DNS
or app. Positive account absence is distinguished from an inability to check;
missing panel fields stay `UNKNOWN`, never coerced to zero. An explicit user
consent attaches a strict, secret-free diagnostic snapshot to a normal support
ticket. Behind an OWNER master switch, bounded cooldown and the existing
per-Service lock — `docs/service-self-diagnostics.md`.

**Free-trial VPN accounts** (disabled by default): eligible users can
claim one real trial account per the operator's policy — an atomic,
DB-guarded `FreeTrialClaim` entitlement that provisions a real panel
account and a real local Service with **zero payment-system writes**
(no orders, payments, wallet or referral effects). Admins configure and
monitor trials per panel (OWNER-only page) and flip the global switch
from «تنظیمات عمومی ⚙️ → تنظیمات اکانت تست 🎁», which also shows exactly
why the user button is hidden (ready/incomplete panel diagnostics). The
user main-menu button «اکانت تست رایگان 🎁» renders — in both keyboard
modes — only while the feature is globally enabled AND at least one
trial-ready panel (config complete, free capacity, valid XUI trial
inbounds) exists; it never appears as a dead placeholder, and stale
callbacks are re-checked server-side. Design in
`docs/free-trial-architecture.md`, operator guide in
`docs/free-trial-admin-management.md`, threat model in
`docs/free-trial-security.md`.

**Trial entitlements & lifecycle**: per-user trial allowances
(`FreeTrialEntitlement` grants with atomic reservation and exactly-once
release, default-allowance policy preserving the legacy once-per-user
semantics) with a per-user admin page «مدیریت اکانت تست 🎁»
(grant/reset/revoke/cooldown/force-resolution, fully audited), OWNER-only
bulk reset campaigns with typed confirmation and a durable resumable
queue, and first-class paid lifecycle on trial services — renewal,
extra volume/time, toggle and link regeneration follow the same
per-action capability rules as paid services, with exactly-once
trial-to-paid conversion. `docs/free-trial-entitlements.md`,
`docs/free-trial-lifecycle.md`, `docs/free-trial-campaigns.md`.

**Referral & affiliate commissions** (Phase 1, disabled by default): every
user gets a personal invite deep link (`t.me/<bot>?start=<code>`) on a
«زیرمجموعه‌گیری 👥» page with a share button and live earnings. When a referred
user completes a paid order, the referrer earns a configured percent of that
order (`floor(amount × percent / 100)`) as a real wallet commission
(`WalletTransaction` type `COMMISSION` / source `REFERRAL`). The payout is
idempotent (one commission per order, enforced by a `@@unique(orderId)` claimed
before any money moves), atomic (increment-with-row-lock ledger write), and
reversible (a refunded order claws the credit back). Financial-safety hardening
makes it **durable** (a worker reconciliation engine recovers any credit/reversal
the live hook missed — a crash or Redis flush never loses money), gated by an
**activation horizon** (only orders completed after payouts were first enabled are
eligible — no historical back-fill), **no-overdraft** on reversal (a shortfall
becomes an auditable `REVERSAL_PENDING` debt collected as funds arrive, never a
negative wallet), and first-purchase-safe under concurrency (a `SELECT … FOR
UPDATE` on the referral). The OWNER enables it and sets the percent /
first-purchase-only / minimum-order policy from «تنظیمات عمومی ⚙️ →
زیرمجموعه‌گیری و پاداش 👥» (with a manual reconcile action and paid/reversed/
pending/net reporting); the user menu button stays hidden and the payout page
fails closed while the program is off. Referral *attribution* (the `/start`
linker, now one atomic claim) is unchanged and always on. See
`docs/referral-affiliate-system.md`.

**Configurable user main-menu keyboard**: admins choose («تنظیمات عمومی ⚙️
→ نوع نمایش منوی کاربر») whether the user main menu renders as inline
glass buttons inside the message (default) or as a persistent reply
keyboard below the input field — one shared menu definition drives both
modes; see `docs/user-menu-keyboard-modes.md`.

**Two-way User/Admin navigation**: active admins get a «پنل مدیریت 🛠» entry
in the user menu, and the admin main menu's final full-width row
«بازگشت به منوی کاربر 👤» returns to the user surface. The return button reuses
the existing user-menu entry (`CB.USER_MENU` inline; the shared `showUserMenu`
after the user-access gates in reply mode), works in both admin keyboard modes,
honors the independently configured user menu mode across all four transitions,
never bypasses the user-access gates, and keeps `/menu` unchanged; sensitive
admin submenus still return to the admin main menu first. See
`docs/admin-menu-keyboard-mode.md`.

**Specialized digital-product workflows**: OTHER_PRODUCT items carry an
admin-selected kind (Apple ID, AI account, Telegram Premium, gift card, or
generic) that drives the creation wizard, the encrypted stock-inventory
format (including an email-boundary Apple-ID parser with fingerprint-based
duplicate detection), structured pre-payment customer-information forms
(encrypted at rest, masked everywhere, consumed exactly once at
settlement — submitting a form never settles a payment), and immutable
per-checkout fulfillment snapshots; paid stock orders with an empty
inventory park as AWAITING_STOCK and complete automatically on refill.
Legacy generic products keep their exact previous behavior. See
`docs/specialized-product-workflows.md`.

**Customer-retention notification engine** (disabled by default): a single
phased engine — persistent `AutomatedNotification` records, one delivery queue
with a CAS worker, quiet hours, daily limits, the `ntf:*` callback namespace, and
one admin health page. Phase 1 covers service-expiry / traffic / status / trial
reminders. Phase 2 adds **abandoned-checkout** and **failed-payment** reminders
(category PAYMENT): a checkout scan on the existing scan queue plus a delivery
re-validation branch. Phase 3 adds automated **customer win-back** campaigns
(category MARKETING, lowest priority): a daily retention scan identifies genuine
previous paying VPN customers who currently have no usable service — measured from
authoritative paid Service/Order history with a fresh-state requirement that
never guesses inactivity — and sends multi-stage reminders (with a lapse-cycle
fingerprint, catch-up, per-user snooze and the existing permanent marketing
opt-out) that re-introduce the storefront. Every reminder can navigate a user back
into the storefront or wallet but never settles a payment, creates an order or
checkout, approves a receipt, spends the wallet, provisions a service, or alters
reconciliation — the financial system stays authoritative. Every new rule is
OWNER-only and stays off until explicitly enabled behind a fail-safe activation
gate. Phase 4 adds a **read-only** analytics layer over the same history:
**evidence-based conversion attribution** (an additive
`NotificationConversionAttribution` linking a completed paid order to the
notification whose recorded click preceded it — converging on `orderId`/
`interactionId` uniqueness so nothing is double-counted and no conversion is ever
fabricated from opens, reads or proximity) plus admin **تحلیل اعلان‌ها 📈** reports
(delivery funnel, CTR, direct/assisted conversions, attributed gross/net revenue —
never profit) in cohort and conversion-timeline views, with an OWNER-only PII-free
CSV export. It is disabled by default and never sends a user-facing message. See
`docs/customer-retention-engine.md`,
`docs/checkout-payment-reminders.md`, `docs/abandoned-checkout-rules.md`,
`docs/payment-retry-notifications.md`, `docs/customer-winback-rules.md`,
`docs/customer-lifecycle-segmentation.md`, `docs/customer-winback-operations.md`,
`docs/notification-analytics.md`, `docs/conversion-attribution.md`,
`docs/analytics-metric-definitions.md`, `docs/notification-analytics-operations.md`.

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
│   ├── backup-db.sh      # Database backup (zedbot-db-YYYYMMDD-HHMMSS.dump[.enc] + manifest)
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

Recurring monthly Service renewals funded by **Telegram Stars subscriptions**
(`createInvoiceLink` + `subscription_period`, `zedbot:sub:` payloads, one local
financial chain per Telegram charge id; **disabled by default**) are a separate
system documented in
[`docs/telegram-stars-service-subscriptions.md`](docs/telegram-stars-service-subscriptions.md)
and its `-payments` / `-refunds` / `-operations` / `-concurrency` siblings. Phase
2.1 adds subscription recovery and operations — Bot API 10.2 subscription-state
Updates (behind a compat shim) + refunded-payment Updates, a durable transaction
cursor with `getStarTransactions` charge recovery (exact-vs-derived expiry that
converges onto one settled charge), PAST_DUE detection, bounded refund retries, a
worker→bot producer/consumer split, reactivation, admin product config + version
drift, an OWNER dashboard with manual reconcile, `/paysupport` (masked charges),
and a Stars-vs-Toman financial report — see
[`docs/telegram-stars-subscription-recovery.md`](docs/telegram-stars-subscription-recovery.md),
[`docs/telegram-stars-subscription-support.md`](docs/telegram-stars-subscription-support.md)
and
[`docs/telegram-stars-subscription-reporting.md`](docs/telegram-stars-subscription-reporting.md).

Wallet-funded recurring renewals (consent-based `ServiceAutoRenewalMandate`;
**disabled by default**) send a **durable advance pre-charge notice** — an
`AUTO_RENEWAL_UPCOMING` notification normally delivered ~24h before the wallet
deduction, deduped per expiry cycle, revalidated against the live price/cycle at
delivery (never a stale amount), with a real cancellation window; the charge is
gated on the notice but never frozen by a Telegram outage. Configured by
`wallet_auto_renewal_precharge_notice_minutes` (`0` disables only the advance
notice). See
[`docs/wallet-auto-renewal-precharge-notices.md`](docs/wallet-auto-renewal-precharge-notices.md).

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
