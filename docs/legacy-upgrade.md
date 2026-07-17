# Self-healing legacy upgrades and deployment identity

Installations that predate PR #92 (the persistent-backup layout) could run
`zedbot update` and still end up serving **old code**: old containers, an
old installed CLI and an old `.env`. This document covers the production
problem, the self-heal that converges such installations automatically, the
current 11-step updater, the post-deploy smoke test, the baked deployment
identity (`GIT_SHA`), the `zedbot deploy-status` report and the CI job that
proves the whole path end to end.

Code: `scripts/update.sh`, `scripts/migrate.sh` (`legacy_self_heal`),
`scripts/lib/common.sh` (the identity/self-heal helpers),
`apps/worker/src/cli/{record-deploy,migration-status,deploy-smoke}.ts`,
`Dockerfile` (identity layers), `scripts/tests/legacy-upgrade-test.sh`.

## The production problem

Observed symptom on a real pre-PR92 server: after `zedbot update` the bot's
«وضعیت سیستم 🩺» page still showed the **old** health layout — the update
had "succeeded", yet the running containers were unchanged. Three defects
stack up on such installations:

1. **Stale containers.** The old updater ran `compose build` followed by a
   plain `up -d`. Compose can leave the previous containers (previous
   image, previous mounts, previous env) running after a rebuild — only
   `--force-recreate` guarantees replacement.
2. **Stale installed CLI.** `/usr/local/bin/zedbot` was installed once and
   never refreshed, so every later `zedbot update` kept executing the OLD
   update logic against new code.
3. **Stale `.env`.** The persistent-backup keys (`ZEDBOT_BACKUP_DIR`,
   `ZEDBOT_RUNTIME_UID/GID`, `BACKUP_RETENTION_DAYS`, …) never appeared,
   and the pre-PR92 `BACKUP_DIR` host path kept its legacy meaning.

Because the stale CLI keeps running the old updater, the fix cannot live in
the new updater alone — it has to ride a file the **old** updater already
executes.

## Why `scripts/migrate.sh` is the self-heal hook

The pre-PR92 updater (`git show 4d0f3ba:scripts/update.sh`) runs:

```
backup.sh → git pull (fetches the NEW code) → compose build → up -d
        → run_migrations_if_available → doctor.sh
```

`run_migrations_if_available` (lib/common.sh) executes
`scripts/migrate.sh` when it exists and is executable. After the pull that
file **is the new code** — making it the ONLY new-code hook the legacy
updater calls. `migrate.sh` therefore ends with `legacy_self_heal`, which
finishes everything the old updater cannot do.

## One-time command for pre-PR92 installations

The chain above depends on the old updater's `git pull --ff-only`
actually succeeding — and on real pre-PR92 hosts it silently does not.
The old installer ran `chmod +x` over scripts that were committed with
mode 644, so every legacy working tree is permanently "dirty" with
mode-only changes; because those same scripts changed upstream, the
ff-only pull is refused, the old updater logs a warning and "completes"
without fetching anything, and no new code ever reaches the machine.

The pull runs entirely inside already-shipped old code, so nothing this
repository ships can fix it retroactively. A pre-PR92 host therefore
needs exactly one manual command before its first `zedbot update`:

```bash
git -C /opt/zedbot/app config core.fileMode false && zedbot update
```

`core.fileMode false` tells git to ignore mode bits in this repository —
script modes on this appliance are the installer's job, not git's. With
the mode noise gone the old updater's pull fast-forwards normally and the
self-heal chain takes over. The command is needed **once, ever**: the new
updater and installer set the flag automatically, all script modes are
now committed as 755, and the CI legacy-upgrade job exercises exactly
this documented path.

## Trigger conditions

`legacy_self_heal` runs only when `legacy_install_detected`
(lib/common.sh) is true, i.e. when at least one of:

- the `.env` exists but has **no `ZEDBOT_BACKUP_DIR=` line** (the marker of
  a pre-PR92 environment), **or**
- the installed CLI is **stale** (`cli_is_stale`: `/usr/local/bin/zedbot`
  is missing, or its sha256 differs from the repository's
  `scripts/zedbot.sh`).

Normal runs of the new updater/installer converge env + CLI **before**
calling `migrate.sh`, so the self-heal no-ops there — it never does the
work twice.

## What the self-heal does

In order (`legacy_self_heal` in `scripts/migrate.sh`, helpers in
`scripts/lib/common.sh`):

1. **Append-only `.env` migration** (`migrate_legacy_env`). Missing keys
   are appended under a `# Persistent backup storage (added by zedbot
   update)` header: `ZEDBOT_BACKUP_DIR`, `ZEDBOT_RUNTIME_UID=1000`,
   `ZEDBOT_RUNTIME_GID=1000`, `BACKUP_RETENTION_DAYS=14`,
   `BACKUP_MIN_RETAINED=3`, `BACKUP_MAX_TELEGRAM_MB=45`,
   `BACKUP_MIN_FREE_DISK_MB=500`. Existing lines are **never rewritten,
   reordered or deleted**; the file keeps mode 600. A legacy `BACKUP_DIR`
   that points at a custom **absolute host path** is honored as the new
   `ZEDBOT_BACKUP_DIR` value (pre-PR92 semantics: `BACKUP_DIR` WAS the
   host location) — except `/var/lib/zedbot/backups`, which is the
   in-container path and never a host directory.
2. **Backup-dir permission repair** (`ensure_backup_dir_permissions`):
   `mkdir -p` + `chown 1000:1000` + `chmod 750`, plus normalizing
   `zedbot-db-*` files to 640. Never deletes anything, never widens beyond
   750.
3. **CLI refresh** (`refresh_cli`): `install -m 0755 scripts/zedbot.sh
   /usr/local/bin/zedbot`, then a byte-for-byte sha256 re-verification. A
   refresh failure is remembered but the remaining steps still run (stale
   containers are worse than a stale CLI); the script then exits non-zero
   so the failure surfaces.
4. **Identity rebuild**: `GIT_SHA="$(repo_head_sha)"` is exported and
   `compose build` re-runs. Because the `GIT_SHA` layers are the LAST ones
   in the Dockerfile, every earlier layer is cached and this rebuild is
   nearly free.
5. **Forced recreation**: `compose up -d --force-recreate
   --remove-orphans` — the actual fix for the stale-container symptom.
6. **Deploy recording** (`record_deployed_sha`): the repository HEAD SHA is
   written into the database Settings via the worker's `record-deploy` CLI
   (best effort — a bookkeeping failure never aborts the deploy).

## The current update flow (11 steps)

`scripts/update.sh` (via the refreshed `zedbot update`):

| Step | Action |
| --- | --- |
| 1/11 | Safety archive (`.env` + database, `scripts/backup.sh`) |
| 2/11 | Pre-update database backup **created and verified** (the update gate — any doubt aborts with the running installation untouched; escape hatch `ZEDBOT_SKIP_PREUPDATE_BACKUP=1`) |
| 3/11 | `git fetch` + `git pull --ff-only` (a non-fast-forwardable checkout warns and continues on the current code) |
| 4/11 | `migrate_legacy_env` (append-only) + re-load `.env` + `ensure_backup_dir_permissions` |
| 5/11 | `refresh_cli` — a refresh failure **aborts the update** (a stale installed CLI driving new code is exactly the bug class this updater prevents) |
| 6/11 | `compose build` with `GIT_SHA="$(repo_head_sha)"` exported (deployment identity) |
| 7/11 | `scripts/migrate.sh` — Prisma migrations + seed **before** the new app containers run (old code on a newer schema beats new code on an older schema); its legacy self-heal no-ops here because steps 4–5 already converged env + CLI |
| 8/11 | `compose up -d --force-recreate --remove-orphans` |
| 9/11 | `record_deployed_sha` (worker `record-deploy` CLI → Settings) |
| 10/11 | Post-deploy smoke test (below) |
| 11/11 | `scripts/doctor.sh` health checks |

Any failure trips the ERR trap, which prints recovery steps (`zedbot
logs` / `zedbot doctor`, retry with `zedbot update`, manual restore via
`zedbot restore-help`) — data and `.env` are never deleted.

## Post-deploy smoke test

Step 10 runs `apps/worker/dist/cli/deploy-smoke.js` in a **one-off** worker
container while the freshly recreated real worker is running, then adds two
bot-side checks from the host. The CLI prints one line of secret-free JSON:
`{ok, failureCategory, filename, operationId, steps}`.

Smoke steps, in order (each failure sets a category and stops):

| Step | Proves | Failure category |
| --- | --- | --- |
| `redis` | Redis answers a PING through the queue client | `REDIS_UNREACHABLE` |
| `worker-heartbeat` | the recreated worker published its heartbeat (waits up to 60 s) | `WORKER_HEARTBEAT_MISSING` |
| `backup-dir-writable` | write+unlink probe on the backup mount | `BACKUP_DIR_NOT_WRITABLE` |
| `pg-client` | `pg_dump` AND `pg_restore` exist in the image | `PG_CLIENT_MISSING` |
| `backup-enqueue` | one real `BackupOperation` + CREATE job enqueued exactly like a bot-triggered backup | `BACKUP_ENQUEUE_FAILED` |
| `backup-verified` | the RUNNING worker processes it to `VERIFIED` within the budget | `BACKUP_FAILED` / `BACKUP_NOT_VERIFIED_IN_TIME` |
| `backup-file` | the verified dump exists on the shared directory | `BACKUP_FILE_MISSING` |

(`UNEXPECTED_ERROR` covers anything that throws outside its own guard.)
Overall budget: `ZEDBOT_SMOKE_TIMEOUT_SECONDS` (default 240), with a hard
emergency timer 30 s later that still emits the JSON verdict. The update
script additionally verifies from the host that the **bot** container can
list the backup mount and sees the exact smoke-produced file through its
read-only mount (retried, because a broken bot token crash-loops the bot
container by design).

**On ANY smoke failure the application is deliberately KEPT RUNNING** — a
failed smoke is a signal to investigate, never a reason to yank a live
deployment — but `zedbot update` exits non-zero and prints the recovery
commands:

```bash
zedbot doctor --fix       # diagnose; repairs backup dir + stale CLI
zedbot repair backups     # fix backup mount ownership/permissions
zedbot logs worker        # inspect the worker
zedbot update             # retry once fixed
```

## Deployment identity (`GIT_SHA`)

- `docker-compose.yml` forwards the `GIT_SHA` build arg to the shared
  Dockerfile for api/bot/worker; `scripts/install.sh`, `scripts/update.sh`
  and the migrate.sh self-heal export it before `compose build`.
- The Dockerfile turns it into `ENV GIT_SHA` / `ENV APP_VERSION` as the
  **last layers** on purpose: rebuilding with a different `GIT_SHA` reuses
  every earlier cached layer, so identity-only rebuilds (the self-heal's
  re-stamp) are nearly free. Images built without the arg carry the
  literal `unknown`, which `normalizeGitSha` (packages/shared/src/ops.ts)
  reads as "no identity" — never as a real version.
- The **worker** publishes its baked `gitSha` in the capability snapshot
  (`zedbot:worker:capabilities`, `apps/worker/src/heartbeat.ts`), so the
  bot can see the worker image's identity without touching the container.
- The **deployed** repo HEAD is recorded in the `deployed_repo_sha`
  Setting (plus `deployed_repo_sha_recorded_at`) by the worker's
  `record-deploy` CLI at the end of every completed deploy.
- The **bot** compares its own baked `GIT_SHA` against `deployed_repo_sha`
  and shows «نسخه در حال اجرا» plus a mismatch warning on «وضعیت سیستم 🩺»,
  and a full repo/bot/worker comparison on «بررسی نصب و بروزرسانی 🧪» —
  see [system-health.md](system-health.md).

## `zedbot deploy-status`

A **read-only report** (never a gate — it always exits 0) of
repository/image/container alignment plus the migration status, degrading
to `unavailable` when containers are down. It never prints env values.
Sample output on a healthy installation:

```
[INFO] Repository HEAD  : 9b27a84a1c (9b27a84a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f)
[ OK ] Installed CLI    : fresh (matches the repository copy)
[INFO] bot:
[INFO]   image ID       : sha256:3f9c2b81d4e5
[INFO]   created        : 2026-07-17T09:15:04.123456789Z
[INFO]   GIT_SHA        : 9b27a84a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f
[INFO] worker:
[INFO]   image ID       : sha256:3f9c2b81d4e5
[INFO]   created        : 2026-07-17T09:15:06.987654321Z
[INFO]   GIT_SHA        : 9b27a84a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f
[INFO] Migrations       : pending=0 upToDate=true
[ OK ] Repository, images and containers MATCH.
```

Interpretation:

- **`Installed CLI : STALE`** — `/usr/local/bin/zedbot` differs from
  `scripts/zedbot.sh`; run `zedbot update` (or `zedbot doctor --fix`).
- **container `GIT_SHA` ≠ repository HEAD** (or `unavailable`) — the
  container runs an old image or is down; the verdict line then reads
  `Deployment is NOT aligned. Run: zedbot update`.
- **`Migrations : pending=N`** with `N > 0` (or `unavailable`) — `prisma
  migrate deploy` is still pending or failed; also flagged as not aligned.

The migration line comes from the worker's `migration-status` CLI (shipped
migrations vs the `_prisma_migrations` table); the per-container `GIT_SHA`
comes from an exec into the running container. `zedbot doctor` carries the
same comparison as two per-service rows (`bot|worker GIT_SHA matches repo
HEAD`) — PASS with the short SHA, or WARN `version mismatch - run: zedbot
update` / `unavailable - …`; `doctor --fix` also refreshes a stale CLI.

## CI: the `legacy-upgrade-smoke` job

`.github/workflows/ci.yml` runs `scripts/tests/legacy-upgrade-test.sh`
with `--iterations 3` (full-history checkout; ~55 min budget). Each
iteration rebuilds a REAL pre-PR92 production installation from scratch:

1. Wipe `/opt/zedbot`, clone a bare origin whose `main` points at the
   tested commit, check the app out at the pre-PR92 merge
   (`4d0f3ba89b0cc3e94fe9c280ade276e2025a19a4`), write the old installer's
   `.env` (legacy `BACKUP_DIR` host path, no `ZEDBOT_*` backup keys),
   install the OLD CLI, create root-owned 700 backup dir with pre-existing
   legacy backup + operator files, build and start the OLD stack, apply
   the OLD migrations.
2. Run the **old** `zedbot update` — the real legacy path: old update.sh →
   pull → build → `up -d` → NEW migrate.sh self-heal.
3. Assert full convergence: repository at the tested commit; CLI refreshed
   byte-for-byte and advertising `deploy-status` / `repair backups` /
   `backup list`; `.env` mode 600, **every original line still present
   verbatim**, each new key added exactly once; compose still parses;
   backup dir `1000:1000` mode 750; pre-existing operator files unchanged
   bit-for-bit; migrations applied incl. the PR92 one; all three app
   containers recreated on a **new** image; worker has PG16 client tools
   and runs as UID 1000; worker heartbeat live; bot mount read-only,
   worker mount writable; the running bot image ships the new admin UI
   strings («نسخه در حال اجرا»); both app containers carry the baked
   `GIT_SHA`.
4. Run a **second** update through the NEW updater (post-deploy smoke
   included), assert a new verified backup appeared and `zedbot
   deploy-status` reports MATCH.
5. Scan both update outputs and the compose logs for leaked
   `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `TELEGRAM_BOT_TOKEN` values.

Three iterations prove idempotence and clean re-runs. Local run (root,
Docker, full-history clone required):

```bash
sudo -E bash scripts/tests/legacy-upgrade-test.sh --iterations 1
```

## Manual recovery

If an upgrade is interrupted or a legacy install still looks stale:

```bash
zedbot deploy-status        # what exactly is out of line?
zedbot doctor --fix         # repairs backup dir perms + refreshes a stale CLI
zedbot update               # the updater is idempotent - just run it again
bash /opt/zedbot/app/scripts/migrate.sh   # standalone: migrations + self-heal
```

If even the installed CLI is broken, bypass it once:

```bash
bash /opt/zedbot/app/scripts/update.sh
```

## Explicit guarantees

- `.env` migration is **append-only**: no existing line is ever rewritten,
  reordered or deleted; the file is never replaced; mode stays 600.
- No backup file is ever deleted by the upgrade path; pre-existing
  operator files in the backup directory survive bit-for-bit.
- Permissions never widen beyond 750 on the directory / 640 on backup
  files — no `chmod 777`, ever.
- The app containers keep running as the unprivileged `node` user
  (UID/GID 1000) — no root containers.
- No secrets in any output: update logs, smoke JSON, `deploy-status`,
  `doctor` and the CI assertions are all secret-free by construction (the
  legacy-upgrade test actively scans for leaks).
- A failed post-deploy smoke **never rolls back or stops** the running
  application; it only fails the update command loudly.
