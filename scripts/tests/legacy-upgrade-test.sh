#!/usr/bin/env bash
# =============================================================================
# ZED_BOT legacy-upgrade integration test (CI: legacy-upgrade-smoke job).
#
# Reproduces a REAL production installation that predates PR #92 (persistent
# backups): old code checked out at PRE_SHA, the old installer's .env (with
# the legacy BACKUP_DIR host path and none of the ZEDBOT_* backup keys), the
# old CLI installed to /usr/local/bin/zedbot, the old stack running with
# applied old migrations. It then runs the OLD `zedbot update`, which pulls
# the CURRENT code and must fully self-heal through the scripts/migrate.sh
# hook (the only new-code hook the legacy updater executes): append-only
# .env migration, CLI refresh, image identity rebuild, forced container
# recreation, deploy-SHA recording. A second update then exercises the NEW
# updater end-to-end (including the post-deploy smoke), and captured output
# is scanned for secret leaks.
#
# Must run as root (CI: sudo -E). Local runs need Docker and a full-history
# clone (commit ${PRE_SHA} must exist). Usage:
#   sudo -E bash scripts/tests/legacy-upgrade-test.sh [--iterations N]
# =============================================================================

set -Eeuo pipefail

# --- Environment sanitation --------------------------------------------------
# A real production root shell carries NONE of the app configuration in its
# environment - everything lives in /opt/zedbot/app/.env. CI (and careless
# local shells) may export dummy values for the unit-test jobs, and Docker
# Compose gives the PROCESS environment precedence over the project .env
# during ${VAR} interpolation: a leaked POSTGRES_PASSWORD would initialize
# postgres with one password while the app containers read another from
# env_file (observed as prisma P1000 / a permanently unhealthy api). Scrub
# every variable the compose file or the zedbot scripts would consume.
unset NODE_ENV APP_NAME APP_DOMAIN APP_BASE_URL API_PORT LOG_LEVEL \
  TELEGRAM_BOT_TOKEN ADMIN_TELEGRAM_IDS \
  POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL \
  REDIS_HOST REDIS_PORT REDIS_PASSWORD REDIS_URL REDISCLI_AUTH \
  APP_SECRET INTERNAL_API_TOKEN SSL_EMAIL GIT_SHA \
  BACKUP_DIR BACKUP_ENCRYPTION_PASSWORD BACKUP_RETENTION_DAYS \
  BACKUP_MIN_RETAINED BACKUP_MAX_TELEGRAM_MB BACKUP_MIN_FREE_DISK_MB \
  ZEDBOT_BASE_DIR ZEDBOT_APP_DIR ZEDBOT_DATA_DIR ZEDBOT_BACKUP_DIR \
  ZEDBOT_LOGS_DIR ZEDBOT_ENV_FILE ZEDBOT_CLI_PATH ZEDBOT_REPO_URL \
  ZEDBOT_SKIP_PREUPDATE_BACKUP ZEDBOT_SMOKE_TIMEOUT_SECONDS \
  2>/dev/null || true

# --- Constants ---------------------------------------------------------------
PRE_SHA=4d0f3ba89b0cc3e94fe9c280ade276e2025a19a4
SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_PATH}/../.." >/dev/null 2>&1 && pwd)"
ORIGIN_DIR=/tmp/zedbot-origin.git
BASE_DIR=/opt/zedbot
APP_DIR="${BASE_DIR}/app"
BACKUP_DIR="${BASE_DIR}/backups"
CLI_PATH=/usr/local/bin/zedbot
BOT_TOKEN_VALUE='123456789:TESTTOKENxxxxxxxxxxxxxxxxxxxxxxxxx'

ITERATIONS=1
ITERATION=0
WORK=""
NEW_SHA=""
PG_PW=""
REDIS_PW=""

# --- Helpers -----------------------------------------------------------------
phase() { printf '\n=== [iteration %s] %s ===\n' "$ITERATION" "$*"; }

dump_diagnostics() {
  echo "--- diagnostics ---" >&2
  docker ps -a --filter 'name=zedbot-' >&2 || true
  if [ -f "${APP_DIR}/docker-compose.yml" ]; then
    (cd "$APP_DIR" && docker compose ps) >&2 || true
    # The api gets the deepest tail: its healthcheck gates the whole stack
    # (bot depends_on api healthy), so it is the usual first casualty.
    (cd "$APP_DIR" && docker compose logs --no-color --tail 150 api) >&2 || true
    (cd "$APP_DIR" && docker compose logs --no-color --tail 60 postgres redis worker bot) >&2 || true
  fi
  return 0
}

# A bare command failure under `set -e` must still explain itself: without
# this trap the script dies silently mid-phase (e.g. `dc up -d` refusing to
# start an unhealthy dependency) and CI shows compose noise but no container
# logs at all.
on_err() {
  local rc=$? line=$1 cmd=$2
  trap - ERR # No recursion while the handler itself runs commands.
  printf 'FATAL: command failed (exit %s) at line %s: %s\n' "$rc" "$line" "$cmd" >&2
  dump_diagnostics
  exit "$rc"
}
trap 'on_err "$LINENO" "$BASH_COMMAND"' ERR

fail() {
  # Suppress the ERR trap for the intentional exit below - the diagnostics
  # are dumped exactly once, right here.
  trap - ERR
  printf 'ASSERT FAIL: %s\n' "$*" >&2
  dump_diagnostics
  exit 1
}

assert_eq() {
  # assert_eq <actual> <expected> <label>
  [ "$1" = "$2" ] || fail "$3 (expected '$2', got '$1')"
}

# retry <attempts> <delay-seconds> <description> <command...>
retry() {
  local attempts="$1" delay="$2" desc="$3"
  shift 3
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      sleep "$delay"
    fi
  done
  fail "timed out waiting for: ${desc}"
}

# docker compose from the app directory (compose reads .env from there).
dc() { (cd "$APP_DIR" && docker compose "$@"); }

wait_healthy() {
  local name="$1" timeout="${2:-180}" waited=0 state
  while [ "$waited" -lt "$timeout" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [ "$state" = "healthy" ]; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  fail "container ${name} did not become healthy within ${timeout}s"
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

file_sha256() { sha256sum "$1" | awk '{print $1}'; }

# --- Probes used with retry (the bot 401-crash-loops by design with the
# --- dummy token: it sleeps before exiting, so the container is Running
# --- most of the time, but a single exec can hit the restart gap) -----------
worker_heartbeat_present() {
  local hb
  hb="$(dc exec -T redis redis-cli GET zedbot:worker:heartbeat 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$hb" ] && [ "$hb" != "(nil)" ]
}

bot_mount_readonly() {
  local out
  out="$(dc exec -T bot sh -c 'ls /var/lib/zedbot/backups >/dev/null 2>&1 || exit 9; if touch /var/lib/zedbot/backups/.legacy-test-w 2>/dev/null; then rm -f /var/lib/zedbot/backups/.legacy-test-w; echo WRITABLE; else echo READONLY; fi' 2>/dev/null || true)"
  if [ "$out" = "WRITABLE" ]; then
    fail "bot backup mount is WRITABLE but must be read-only"
  fi
  [ "$out" = "READONLY" ]
}

bot_has_new_admin_ui() {
  dc exec -T bot grep -rl "نسخه در حال اجرا" apps/bot/dist >/dev/null 2>&1
}

bot_git_sha_matches() {
  local s
  s="$(dc exec -T bot sh -c 'printf "%s" "${GIT_SHA:-}"' 2>/dev/null | tr -d '[:space:]' || true)"
  [ "$s" = "$NEW_SHA" ]
}

deploy_status_matches() {
  local out
  out="$("$CLI_PATH" deploy-status 2>&1)" || return 1
  printf '%s\n' "$out" > "${WORK}/deploy-status.log"
  printf '%s' "$out" | grep -q "MATCH"
}

# --- One-time setup ----------------------------------------------------------
setup_origin() {
  echo "=== setup: bare origin at ${ORIGIN_DIR} (main -> ${NEW_SHA}) ==="
  rm -rf "$ORIGIN_DIR"
  git clone --bare "$REPO_ROOT" "$ORIGIN_DIR"
  # Guarantee the tested commit is present and reachable: a detached-HEAD CI
  # checkout may not have it on any branch of the fresh bare clone.
  git -C "$REPO_ROOT" push --force "$ORIGIN_DIR" "${NEW_SHA}:refs/heads/main"
  git -C "$ORIGIN_DIR" symbolic-ref HEAD refs/heads/main
  git -C "$ORIGIN_DIR" cat-file -e "${PRE_SHA}^{commit}" \
    || fail "pre-PR92 commit ${PRE_SHA} is missing - clone with full history (fetch-depth: 0)"
}

# --- Per-iteration phases ----------------------------------------------------
reset_environment() {
  phase "reset (down -v, wipe ${BASE_DIR}, remove installed CLI)"
  if [ -f "${APP_DIR}/docker-compose.yml" ]; then
    (cd "$APP_DIR" && docker compose down -v --remove-orphans) || true
  fi
  # Belt and braces against leftovers from a previously failed iteration.
  docker ps -aq --filter 'name=zedbot-' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm zedbot >/dev/null 2>&1 || true
  rm -rf "$BASE_DIR"
  rm -f "$CLI_PATH"
}

create_legacy_layout() {
  phase "legacy layout: clone at PRE_SHA + pre-PR92 .env"
  mkdir -p "$BASE_DIR"
  git clone "$ORIGIN_DIR" "$APP_DIR"
  git -C "$APP_DIR" checkout -B main "$PRE_SHA"
  git -C "$APP_DIR" branch --set-upstream-to=origin/main main

  PG_PW="$(generate_password)"
  REDIS_PW="$(generate_password)"
  local app_secret internal_token
  app_secret="$(generate_password)"
  internal_token="$(generate_password)"

  # Replicates the .env the PRE-PR92 installer produced (key set and quoting
  # from `git show 4d0f3ba:scripts/install.sh`): legacy host BACKUP_DIR, no
  # ZEDBOT_BACKUP_DIR / ZEDBOT_RUNTIME_* / BACKUP_RETENTION_* keys.
  # BACKUP_ENCRYPTION_PASSWORD is left empty on purpose: the encrypted-backup
  # path has its own coverage and an empty value keeps this test focused on
  # the upgrade machinery (plain .dump files, postgres-side verification).
  local old_umask
  old_umask="$(umask)"
  umask 077
  cat > "${APP_DIR}/.env" <<EOF
# ZED_BOT environment configuration
# Generated by install.sh on 2026-07-01 00:00:00 UTC
# This file contains credentials - keep it secret (chmod 600).

# --- Application ---
NODE_ENV='production'
APP_NAME='ZED_BOT'
APP_DOMAIN='ci.zedbot.local'
APP_BASE_URL='https://ci.zedbot.local'
API_PORT='3000'
LOG_LEVEL='info'

# --- SSL (reverse proxy / certificates land in a later phase) ---
SSL_EMAIL='admin@ci.zedbot.local'

# --- Telegram ---
TELEGRAM_BOT_TOKEN='${BOT_TOKEN_VALUE}'
ADMIN_TELEGRAM_IDS='1'

# --- PostgreSQL ---
POSTGRES_DB='zedbot'
POSTGRES_USER='zedbot'
POSTGRES_PASSWORD='${PG_PW}'
DATABASE_URL='postgresql://zedbot:${PG_PW}@postgres:5432/zedbot'

# --- Redis ---
REDIS_HOST='redis'
REDIS_PORT='6379'
REDIS_PASSWORD='${REDIS_PW}'
REDIS_URL='redis://:${REDIS_PW}@redis:6379/0'

# --- Application secrets ---
APP_SECRET='${app_secret}'
INTERNAL_API_TOKEN='${internal_token}'

# --- Backups ---
BACKUP_DIR='/opt/zedbot/backups'
# When set, backups are encrypted (AES-256). Keep a copy of this password
# somewhere safe OUTSIDE this server - encrypted backups are useless without
# it. Empty value = unencrypted backups.
BACKUP_ENCRYPTION_PASSWORD=''

# --- Paths (used by docker-compose bind mounts) ---
ZEDBOT_DATA_DIR='/opt/zedbot/data'
EOF
  umask "$old_umask"
  chmod 600 "${APP_DIR}/.env"

  if grep -q '^ZEDBOT_BACKUP_DIR=' "${APP_DIR}/.env"; then
    fail "test setup bug: the legacy .env must not contain ZEDBOT_BACKUP_DIR"
  fi

  # Faithful replication of the pre-PR92 installer (install.sh line ~486):
  # it chmod +x'ed every script in the clone even though several were
  # committed 644, leaving every real legacy tree MODE-DIRTY. This is what
  # silently blocked `git pull --ff-only` in the old updater on production
  # hosts - the exact defect the fileMode bridge below exists for.
  chmod +x "${APP_DIR}/scripts/"*.sh "${APP_DIR}/scripts/zedbot"
}

create_legacy_dirs_and_backups() {
  phase "legacy dirs + pre-existing backup files (root-owned 700 dir)"
  mkdir -p "${BASE_DIR}/data" "${BASE_DIR}/logs"
  mkdir -p "$BACKUP_DIR"
  chown root:root "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  printf -- '-- legacy ZED_BOT dump\nSELECT 1;\n' | gzip > "${BACKUP_DIR}/zedbot-db-20260101-000000.sql.gz"
  printf 'operator notes - must survive every upgrade untouched\n' > "${BACKUP_DIR}/operator-notes.txt"
  LEGACY_DUMP_SHA="$(file_sha256 "${BACKUP_DIR}/zedbot-db-20260101-000000.sql.gz")"
  NOTES_SHA="$(file_sha256 "${BACKUP_DIR}/operator-notes.txt")"
}

install_legacy_cli() {
  phase "install the PRE-PR92 CLI to ${CLI_PATH}"
  local tmp_cli
  tmp_cli="$(mktemp "${WORK}/old-cli.XXXXXX")"
  git -C "$APP_DIR" show "${PRE_SHA}:scripts/zedbot.sh" > "$tmp_cli"
  install -m 0755 "$tmp_cli" "$CLI_PATH"
  rm -f "$tmp_cli"
}

start_legacy_stack() {
  phase "build + start the OLD stack and apply OLD migrations"
  dc build
  # The scenario under test is a LONG-RUNNING legacy production install, so
  # its database always has the old migrations applied. Bring up only the
  # data services first and migrate before booting the app containers -
  # `dc up -d` for the full stack would gate on the api healthcheck (bot
  # depends_on api healthy), and an api booting against a bare database is
  # the fresh-install bootstrap transient, not the steady state this test
  # reproduces.
  dc up -d postgres redis
  wait_healthy zedbot-postgres 180
  wait_healthy zedbot-redis 120
  # The old installer ran migrate.sh through run_migrations_if_available;
  # at PRE_SHA the script exists, so run it exactly like the installer did.
  (cd "$APP_DIR" && bash scripts/migrate.sh) || fail "OLD migrate.sh failed on the legacy stack"
  dc up -d
  wait_healthy zedbot-api 180

  OLD_IMAGE_ID="$(docker inspect -f '{{.Image}}' zedbot-worker)"
  OLD_BOT_CID="$(docker inspect -f '{{.Id}}' zedbot-bot)"
  OLD_WORKER_CID="$(docker inspect -f '{{.Id}}' zedbot-worker)"
  OLD_API_CID="$(docker inspect -f '{{.Id}}' zedbot-api)"
  echo "old image: ${OLD_IMAGE_ID}"
}

run_first_update() {
  phase "THE REAL UPDATE: old CLI -> old update.sh -> pull -> new migrate.sh self-heal"
  cp -a "${APP_DIR}/.env" "${WORK}/env-before-update"
  # The documented ONE-TIME bridge for pre-PR92 installations (see
  # docs/legacy-upgrade.md): the old updater runs entirely OLD code up to and
  # including its ff-only pull, and the old installer's chmod left the tree
  # mode-dirty, so without this the pull is refused and the update "succeeds"
  # without fetching anything. New installer/updater generations set it
  # automatically; the already-shipped generation needs it exactly once.
  git -C "$APP_DIR" config core.fileMode false
  local rc=0
  env ZEDBOT_NONINTERACTIVE=1 "$CLI_PATH" update 2>&1 | tee "${WORK}/update-1.log" || rc=$?
  [ "$rc" -eq 0 ] || fail "first update (legacy path) exited ${rc} - must exit 0"
}

assert_converged() {
  phase "assertions: repository, CLI, .env, backups, containers, identity"

  # Repository fast-forwarded to the tested commit.
  local head
  head="$(git -C "$APP_DIR" rev-parse HEAD)"
  assert_eq "$head" "$NEW_SHA" "repository HEAD after the legacy update"

  # Installed CLI refreshed byte-for-byte.
  assert_eq "$(file_sha256 "$CLI_PATH")" "$(file_sha256 "${APP_DIR}/scripts/zedbot.sh")" \
    "installed CLI sha256 vs repository scripts/zedbot.sh"

  # The refreshed CLI advertises the new surface.
  local help_out
  help_out="$("$CLI_PATH" help)"
  local needle
  for needle in "deploy-status" "repair backups" "backup list"; do
    printf '%s' "$help_out" | grep -qF "$needle" || fail "zedbot help does not mention '${needle}'"
  done

  # .env: mode intact, append-only (every original line still present
  # verbatim), new keys added exactly once.
  assert_eq "$(stat -c '%a' "${APP_DIR}/.env")" "600" ".env mode after the update"
  local line
  while IFS= read -r line; do
    grep -qxF -- "$line" "${APP_DIR}/.env" \
      || fail "original .env line was rewritten or removed (key: ${line%%=*})"
  done < "${WORK}/env-before-update"
  assert_eq "$(grep -c '^ZEDBOT_BACKUP_DIR=' "${APP_DIR}/.env")" "1" "number of ZEDBOT_BACKUP_DIR lines in .env"
  grep -q '^ZEDBOT_RUNTIME_UID=' "${APP_DIR}/.env" || fail ".env lacks ZEDBOT_RUNTIME_UID after migration"
  grep -q '^ZEDBOT_RUNTIME_GID=' "${APP_DIR}/.env" || fail ".env lacks ZEDBOT_RUNTIME_GID after migration"

  # Compose still parses with the legacy BACKUP_DIR present in .env.
  dc config --quiet || fail "docker compose config failed with the migrated .env"

  # Backup dir handed to the container runtime user, never world-accessible.
  assert_eq "$(stat -c '%u:%g' "$BACKUP_DIR")" "1000:1000" "backup dir owner"
  assert_eq "$(stat -c '%a' "$BACKUP_DIR")" "750" "backup dir mode"

  # Pre-existing operator files survive the upgrade bit-for-bit.
  [ -f "${BACKUP_DIR}/zedbot-db-20260101-000000.sql.gz" ] || fail "pre-existing legacy backup vanished"
  [ -f "${BACKUP_DIR}/operator-notes.txt" ] || fail "operator-notes.txt vanished"
  assert_eq "$(file_sha256 "${BACKUP_DIR}/zedbot-db-20260101-000000.sql.gz")" "$LEGACY_DUMP_SHA" \
    "legacy backup content unchanged"
  assert_eq "$(file_sha256 "${BACKUP_DIR}/operator-notes.txt")" "$NOTES_SHA" \
    "operator-notes.txt content unchanged"

  # Migrations applied, including the PR92 one.
  local applied="" pr92=""
  applied="$(dc exec -T postgres psql -U zedbot -d zedbot -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]' || true)"
  { [ -n "$applied" ] && [ "$applied" -gt 0 ]; } || fail "no finished migrations found (got '${applied}')"
  pr92="$(dc exec -T postgres psql -U zedbot -d zedbot -tAc \
    "SELECT count(*) FROM _prisma_migrations WHERE migration_name LIKE '%backup_operations_and_log_delivery%' AND finished_at IS NOT NULL" | tr -d '[:space:]' || true)"
  { [ -n "$pr92" ] && [ "$pr92" -ge 1 ]; } || fail "PR92 migration backup_operations_and_log_delivery not applied"

  # Containers recreated on a NEW image.
  local new_image new_bot_cid new_worker_cid new_api_cid
  new_image="$(docker inspect -f '{{.Image}}' zedbot-worker)"
  new_bot_cid="$(docker inspect -f '{{.Id}}' zedbot-bot)"
  new_worker_cid="$(docker inspect -f '{{.Id}}' zedbot-worker)"
  new_api_cid="$(docker inspect -f '{{.Id}}' zedbot-api)"
  [ "$new_image" != "$OLD_IMAGE_ID" ] || fail "worker still runs the OLD image after the update"
  [ "$new_bot_cid" != "$OLD_BOT_CID" ] || fail "bot container was NOT recreated"
  [ "$new_worker_cid" != "$OLD_WORKER_CID" ] || fail "worker container was NOT recreated"
  [ "$new_api_cid" != "$OLD_API_CID" ] || fail "api container was NOT recreated"

  # Worker: PostgreSQL 16 client tools, unprivileged runtime user.
  dc exec -T worker pg_dump --version | grep -q ' 16' || fail "worker pg_dump is not major version 16"
  dc exec -T worker pg_restore --version | grep -q ' 16' || fail "worker pg_restore is not major version 16"
  assert_eq "$(dc exec -T worker id -u | tr -d '[:space:]')" "1000" "worker container uid"

  # Worker heartbeat (proves the NEW worker code is actually running).
  retry 30 3 "worker heartbeat in redis (within 90s)" worker_heartbeat_present

  # Bot: read-only view of the shared mount; worker: read-write probe.
  retry 12 5 "bot sees the backup mount read-only" bot_mount_readonly
  dc exec -T worker sh -c 'touch /var/lib/zedbot/backups/.legacy-test-w && rm -f /var/lib/zedbot/backups/.legacy-test-w' \
    || fail "worker cannot write to the backup mount"

  # The RUNNING bot image ships the new admin UI strings.
  retry 12 5 "new admin UI strings inside the running bot container" bot_has_new_admin_ui

  # Baked deployment identity on both app containers.
  local worker_sha=""
  worker_sha="$(dc exec -T worker sh -c 'printf "%s" "${GIT_SHA:-}"' | tr -d '[:space:]' || true)"
  assert_eq "$worker_sha" "$NEW_SHA" "worker container GIT_SHA"
  retry 12 5 "bot container GIT_SHA == ${NEW_SHA}" bot_git_sha_matches

  echo "all convergence assertions passed."
}

run_second_update_and_assert() {
  phase "second update through the NEW updater (post-deploy smoke included)"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' \) | sort > "${WORK}/dumps-before"

  local rc=0
  env ZEDBOT_NONINTERACTIVE=1 "$CLI_PATH" update 2>&1 | tee "${WORK}/update-2.log" || rc=$?
  [ "$rc" -eq 0 ] || fail "second update (new path) exited ${rc} - must exit 0"

  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' \) | sort > "${WORK}/dumps-after"
  local new_files newest_name
  new_files="$(comm -13 "${WORK}/dumps-before" "${WORK}/dumps-after")"
  [ -n "$new_files" ] || fail "no new zedbot-db-*.dump[.enc] appeared during the second update"
  newest_name="$(printf '%s\n' "$new_files" | tail -n 1)"
  newest_name="${newest_name##*/}"

  "$CLI_PATH" backup list 2>&1 | tee "${WORK}/backup-list.log"
  grep -F "$newest_name" "${WORK}/backup-list.log" | grep -Eq 'yes[[:space:]]*$' \
    || fail "zedbot backup list does not show ${newest_name} as verified=yes"

  retry 6 10 "zedbot deploy-status exits 0 and reports MATCH" deploy_status_matches
}

scan_for_secret_leaks() {
  phase "secret-leak scan over both update outputs + docker compose logs"
  dc logs --no-color > "${WORK}/compose.log" 2>&1 || true
  scan_one() {
    local label="$1" value="$2"
    if grep -RFq -- "$value" "${WORK}/update-1.log" "${WORK}/update-2.log" "${WORK}/compose.log"; then
      fail "the ${label} value leaked into captured update output or container logs"
    fi
  }
  scan_one "POSTGRES_PASSWORD" "$PG_PW"
  scan_one "REDIS_PASSWORD" "$REDIS_PW"
  scan_one "TELEGRAM_BOT_TOKEN" "$BOT_TOKEN_VALUE"
  echo "secret scan clean."
}

# --- Main --------------------------------------------------------------------
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --iterations)
        ITERATIONS="${2:?--iterations requires a number}"
        shift 2
        ;;
      *)
        echo "Unknown argument: $1 (supported: --iterations N)" >&2
        exit 2
        ;;
    esac
  done

  if [ "$(id -u)" -ne 0 ]; then
    echo "This test must run as root (CI runs it via sudo -E)." >&2
    exit 1
  fi
  command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

  # Root reads the runner-user-owned checkout: register it as safe first.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO_ROOT"; then
    git config --global --add safe.directory "$REPO_ROOT" >/dev/null 2>&1 || true
  fi

  NEW_SHA="${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  echo "PRE_SHA=${PRE_SHA}"
  echo "NEW_SHA=${NEW_SHA}"

  setup_origin

  local i
  for ((i = 1; i <= ITERATIONS; i++)); do
    ITERATION="$i"
    WORK="$(mktemp -d "/tmp/zedbot-legacy-test-iter${i}.XXXXXX")"
    echo
    echo "################ iteration ${i}/${ITERATIONS} (logs: ${WORK}) ################"
    reset_environment
    create_legacy_layout
    create_legacy_dirs_and_backups
    install_legacy_cli
    start_legacy_stack
    run_first_update
    assert_converged
    run_second_update_and_assert
    scan_for_secret_leaks
    echo "################ iteration ${i}/${ITERATIONS} PASSED ################"
  done

  echo
  echo "legacy-upgrade-test: all ${ITERATIONS} iteration(s) passed."
}

main "$@"
