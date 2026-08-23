#!/usr/bin/env bash
# =============================================================================
# ZED_BOT doctor: prints a pass/fail table of system health checks.
#
# Exit code: 1 only when the CORE system is broken (Docker/Compose/app files
# missing); optional runtime checks report WARN without failing hard.
#
# `doctor --fix` additionally repairs the backup directory ownership and
# permissions (ensure_backup_dir_permissions: mkdir -p, chown to the runtime
# UID/GID, chmod 750 - never deletes anything). Without the flag the doctor
# stays strictly read-only and only reports.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
CORE_BROKEN=0

print_row() {
  local status="$1" color="$2" label="$3" hint="${4:-}"
  printf '  %s%-6s%s %s' "$color" "$status" "$_C_RESET" "$label"
  if [ -n "$hint" ]; then
    printf '  (%s)' "$hint"
  fi
  printf '\n'
}

# core_check "<label>" <command...>  -> FAIL marks the core system as broken
core_check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    print_row "PASS" "$_C_GREEN" "$label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    print_row "FAIL" "$_C_RED" "$label"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    CORE_BROKEN=1
  fi
}

# optional_check "<label>" "<hint-shown-on-warn>" <command...>
optional_check() {
  local label="$1" hint="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then
    print_row "PASS" "$_C_GREEN" "$label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    print_row "WARN" "$_C_YELLOW" "$label" "$hint"
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
}

skip_check() {
  local label="$1" hint="$2"
  print_row "SKIP" "$_C_BLUE" "$label" "$hint"
}

# --- Individual checks ---------------------------------------------------
check_ubuntu() {
  [ -r /etc/os-release ] && ( . /etc/os-release && [ "${ID:-}" = "ubuntu" ] )
}

# Telegram token readiness (fix/worker-telegram-token-env-contract §5). Reads the
# loaded env (never prints a value): PASS only when the canonical
# TELEGRAM_BOT_TOKEN is set and does not conflict with a differing BOT_TOKEN.
# A legacy-only BOT_TOKEN, a conflicting pair, or a missing token all WARN and
# point at `zedbot env-check` for the authoritative, runtime-matching detail.
check_telegram_token() {
  # Edge-trim both loaded values (shared trim_env_token_value) BEFORE the
  # presence/conflict comparisons, so a whitespace-only value reads as unset
  # exactly like the runtime resolver: a "   " token must never PASS or count as
  # configured, and a padded-but-equal pair is not a conflict.
  local tg bt
  tg="$(trim_env_token_value "${TELEGRAM_BOT_TOKEN:-}")"
  bt="$(trim_env_token_value "${BOT_TOKEN:-}")"
  if [ -n "$tg" ] && [ -n "$bt" ] && [ "$tg" != "$bt" ]; then
    return 1 # conflict (differing usable values)
  fi
  [ -n "$tg" ] # canonical set (equal-duplicate is fine); legacy-only/missing WARN
}

check_cli_fresh() {
  ! cli_is_stale
}

check_compose_available() {
  docker compose version >/dev/null 2>&1 || docker_compose_binary_is_v2
}

check_any_container_running() {
  compose_service_running api || compose_service_running bot || compose_service_running worker ||
    compose_service_running postgres || compose_service_running redis
}

# True only while no process currently holds the deployment lock: a
# non-blocking trial acquisition that releases immediately. Never creates the
# lock file itself, so a first-install with no lock file yet is "free" too.
deployment_lock_is_free() {
  [ -e "$ZEDBOT_DEPLOYMENT_LOCK" ] || return 0
  exec 8<"$ZEDBOT_DEPLOYMENT_LOCK" 2>/dev/null || return 0
  if /usr/bin/flock -n 8; then
    /usr/bin/flock -u 8
    exec 8<&-
    return 0
  fi
  exec 8<&-
  return 1
}

# Purely observational deployment-state consistency check. It neither acquires
# the operation lock nor repairs, recovers, promotes, converts, or removes any
# evidence (the free/held probe above is a released trial lock, not the real
# one). Empty first-install state and a completed canonical installation are
# valid; every partial, conflicting, failed, or unfinished transition fails -
# UNLESS the deployment lock is currently held, in which case a non-promoted
# stage or a live metadata-transition file is the expected shape of the very
# update/rollback that is running right now (e.g. update.sh's own "[14/14]
# Running health checks" step invokes this doctor.sh instance from inside its
# own locked, still-in-progress operation), not evidence of an abandoned one.
check_deployment_state_consistency() {
  local classification stage lock_held=0
  reset_deployment_state_fixed_identity
  validate_deployment_path_contract || return 1

  if [ ! -e "$ZEDBOT_DEPLOYMENT_DIR" ] && [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ]; then
    return 0
  fi
  [ -d "$ZEDBOT_DEPLOYMENT_DIR" ] && [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ] || return 1

  classification="$(classify_installation first-install)" || return 1
  case "$classification" in
    genuine-first-install) return 0 ;;
    existing-canonical) ;;
    *) return 1 ;;
  esac

  deployment_lock_is_free || lock_held=1

  if [ -e "$ZEDBOT_METADATA_TRANSITION" ] || [ -L "$ZEDBOT_METADATA_TRANSITION" ]; then
    [ "$lock_held" -eq 1 ] || return 1
  fi
  if [ -e "$ZEDBOT_OPERATION_STATE" ] || [ -L "$ZEDBOT_OPERATION_STATE" ]; then
    validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 1
    stage="$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")" || return 1
    [ "$stage" = promoted ] || [ "$lock_held" -eq 1 ] || return 1
  fi
  if [ -e "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ] || [ -L "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ]; then
    assert_no_unresolved_failed_generation || return 1
  fi
}

check_postgres_reachable() {
  # -h 127.0.0.1 probes TCP (what the apps use), not just the unix socket.
  run_compose exec -T postgres pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-zedbot}" -d "${POSTGRES_DB:-zedbot}"
}

check_redis_reachable() {
  # REDISCLI_AUTH is set on the container by docker-compose.yml, so no
  # password appears on the command line.
  run_compose exec -T redis redis-cli ping | grep -q PONG
}

check_api_health() {
  local port="${API_PORT:-3000}"
  if has_command curl; then
    curl -fsS --max-time 5 "http://127.0.0.1:${port}/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
  else
    wget -q -O - --timeout=5 "http://127.0.0.1:${port}/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
  fi
}

# At least 2 GB free on the filesystem holding /opt/zedbot.
check_disk_space() {
  local avail_kb
  avail_kb="$(df -Pk "$ZEDBOT_BASE_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -z "$avail_kb" ]; then
    avail_kb="$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
  fi
  [ -n "$avail_kb" ] && [ "$avail_kb" -ge 2097152 ]
}

# At least ~1 GB of RAM total and some headroom available.
check_memory() {
  local total_kb avail_kb
  total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [ "$total_kb" -ge 900000 ] && [ "$avail_kb" -ge 150000 ]
}

check_api_port_listening() {
  ss -ltn 2>/dev/null | grep -q ":${API_PORT:-3000} "
}

# Backup directory: exists, owned by the container runtime user and not
# world-accessible (the bot mounts it ro, the worker rw, both as UID 1000).
check_backup_dir_exists() {
  test -d "$ZEDBOT_BACKUP_DIR"
}

check_backup_dir_owner() {
  local owner expected
  owner="$(stat -c '%u:%g' "$ZEDBOT_BACKUP_DIR" 2>/dev/null || echo '')"
  expected="${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}"
  [ "$owner" = "$expected" ]
}

check_backup_dir_mode() {
  local mode
  mode="$(stat -c '%a' "$ZEDBOT_BACKUP_DIR" 2>/dev/null || echo '')"
  [ -n "$mode" ] || return 1
  # 750 or stricter: owner rwx, no group write, nothing for the world.
  [ $(( 0$mode & 0027 )) -eq 0 ] && [ $(( 0$mode & 0700 )) -eq 448 ]
}

# Deployment identity: one row per app container comparing its baked GIT_SHA
# (Dockerfile build arg) against the repository HEAD. Three outcomes:
#   PASS  container runs the repository HEAD
#   WARN  "version mismatch - run: zedbot update" (stale container/image)
#   WARN  "unavailable" (container down / exec failed / SHA not determinable)
report_version_row() {
  local svc="$1" head_sha="$2" container_sha
  local label="${svc} GIT_SHA matches repo HEAD"
  if [ -z "$head_sha" ]; then
    print_row "WARN" "$_C_YELLOW" "$label" "unavailable - repository SHA not determinable"
    WARN_COUNT=$((WARN_COUNT + 1))
    return 0
  fi
  if ! compose_service_running "$svc"; then
    print_row "WARN" "$_C_YELLOW" "$label" "unavailable - container not running"
    WARN_COUNT=$((WARN_COUNT + 1))
    return 0
  fi
  # "unset" marks images that predate the identity layers; an exec failure
  # (restart gap) yields an empty string instead.
  container_sha="$(run_compose exec -T "$svc" sh -c 'printf "%s" "${GIT_SHA:-unset}"' 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -z "$container_sha" ]; then
    print_row "WARN" "$_C_YELLOW" "$label" "unavailable - could not read the container GIT_SHA"
    WARN_COUNT=$((WARN_COUNT + 1))
  elif [ "$container_sha" = "$head_sha" ]; then
    print_row "PASS" "$_C_GREEN" "${label} (${container_sha:0:10})"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    print_row "WARN" "$_C_YELLOW" "$label" "version mismatch - run: zedbot update"
    WARN_COUNT=$((WARN_COUNT + 1))
  fi
}

main() {
  require_root
  load_env_if_exists

  FIX_MODE=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --fix) FIX_MODE=1 ;;
      *)
        log_error "Unknown option: ${arg} (supported: --fix)"
        exit 1
        ;;
    esac
  done

  echo
  log_info "ZED_BOT doctor - system health check"
  echo
  printf '  %-6s %s\n' "STATUS" "CHECK"
  printf '  %-6s %s\n' "------" "-----------------------------------------"

  # Core system
  optional_check "OS is Ubuntu" "primary supported versions are Ubuntu 24.04/26.04" check_ubuntu
  core_check "Docker installed" has_command docker
  core_check "Docker daemon running" docker info
  core_check "Docker Compose available" check_compose_available
  core_check "App directory exists (${ZEDBOT_APP_DIR})" test -d "$ZEDBOT_APP_DIR"
  core_check "docker-compose.yml exists" test -f "${ZEDBOT_APP_DIR}/docker-compose.yml"
  core_check "Canonical deployment state is complete and consistent" check_deployment_state_consistency
  optional_check ".env exists" "run the installer to create it" test -f "$ZEDBOT_ENV_FILE"
  # Telegram token readiness — presence + conflict only, never the value. The bot
  # and worker share TELEGRAM_BOT_TOKEN (BOT_TOKEN is a legacy fallback); a
  # conflicting pair is a real config error surfaced by `zedbot env-check`.
  optional_check "Telegram bot token configured (TELEGRAM_BOT_TOKEN)" \
    "set TELEGRAM_BOT_TOKEN in .env (BOT_TOKEN is a legacy fallback); run: zedbot env-check" \
    check_telegram_token

  # System resources
  optional_check "Disk space (>= 2 GB free on ${ZEDBOT_BASE_DIR})" "free up disk space" check_disk_space
  optional_check "Memory (>= 1 GB total, headroom available)" "server may be too small or under memory pressure" check_memory

  # Backup directory (shared bind mount: bot ro, worker rw, runtime user)
  if [ "$FIX_MODE" -eq 1 ]; then
    log_info "--fix: repairing backup directory ownership/permissions (${ZEDBOT_BACKUP_DIR}) ..."
    ensure_backup_dir_permissions
  fi
  # Installed CLI freshness (a stale /usr/local/bin/zedbot keeps driving old
  # scripts after an update - the legacy-upgrade bug class).
  if [ "$FIX_MODE" -eq 1 ] && cli_is_stale; then
    log_info "--fix: refreshing the installed CLI from the repository copy ..."
    refresh_cli || log_warn "CLI refresh failed - check ${ZEDBOT_CLI_PATH} permissions."
  fi
  optional_check "Installed CLI is fresh (${ZEDBOT_CLI_PATH})" "run: zedbot update (or: zedbot doctor --fix)" check_cli_fresh

  optional_check "Backup dir exists (${ZEDBOT_BACKUP_DIR})" "run: zedbot doctor --fix (or: zedbot repair backups)" check_backup_dir_exists
  if [ -d "$ZEDBOT_BACKUP_DIR" ]; then
    optional_check "Backup dir owner is ${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000} (container runtime user)" "run: zedbot doctor --fix" check_backup_dir_owner
    optional_check "Backup dir mode is 750 or stricter (no world access)" "run: zedbot doctor --fix" check_backup_dir_mode
  else
    skip_check "Backup dir owner is ${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000} (container runtime user)" "directory missing"
    skip_check "Backup dir mode is 750 or stricter (no world access)" "directory missing"
  fi

  # Runtime (only meaningful when the core is intact)
  if [ "$CORE_BROKEN" -eq 1 ]; then
    skip_check "Container / connectivity checks" "core system is broken, fix the FAIL items first"
  else
    optional_check "Containers are running" "start them with: zedbot start" check_any_container_running
    optional_check "postgres container is running" "zedbot logs postgres" compose_service_running postgres
    optional_check "redis container is running" "zedbot logs redis" compose_service_running redis

    if compose_service_running postgres; then
      optional_check "postgres is reachable" "zedbot logs postgres" check_postgres_reachable
    else
      skip_check "postgres is reachable" "container not running"
    fi

    if compose_service_running redis; then
      optional_check "redis is reachable" "zedbot logs redis" check_redis_reachable
    else
      skip_check "redis is reachable" "container not running"
    fi

    if compose_service_running api; then
      optional_check "API port ${API_PORT:-3000} is listening" "zedbot logs api" check_api_port_listening
      optional_check "API health endpoint responds" "zedbot logs api" check_api_health
    else
      skip_check "API port ${API_PORT:-3000} is listening" "api container not running"
      skip_check "API health endpoint responds" "api container not running"
    fi

    # Deployment identity: running containers vs repository HEAD.
    local head_sha
    head_sha="$(repo_head_sha)"
    report_version_row bot "$head_sha"
    report_version_row worker "$head_sha"
  fi

  echo
  log_info "Summary: ${PASS_COUNT} passed, ${WARN_COUNT} warnings, ${FAIL_COUNT} failed."

  if [ "$CORE_BROKEN" -eq 1 ]; then
    log_error "Core system problems detected. Re-run the installer or fix the FAIL items above."
    exit 1
  fi
  if [ "$WARN_COUNT" -gt 0 ]; then
    log_warn "The core system is healthy, but some runtime checks need attention."
  else
    log_success "All checks passed."
  fi
  exit 0
}

# Run only when executed directly (zedbot doctor). Sourcing the script - e.g. a
# unit test exercising check_telegram_token - loads the functions without running
# the full diagnostic. In production doctor.sh is always executed, so main runs.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
