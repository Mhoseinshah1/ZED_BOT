#!/usr/bin/env bash
# =============================================================================
# ZED_BOT - shared shell helpers
#
# This file is sourced by the ZED_BOT management scripts (zedbot.sh,
# update.sh, backup.sh, backup-db.sh, doctor.sh). It is not meant to be
# executed directly.
#
# NOTE: scripts/install.sh intentionally does NOT source this file, because
# it must run standalone via:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
# before the repository has been cloned. Keep the helpers here and the
# bootstrap copies in install.sh behaviourally in sync.
# =============================================================================

set -Eeuo pipefail

# --- Paths and constants (overridable via environment for testing) ----------
ZEDBOT_BASE_DIR="${ZEDBOT_BASE_DIR:-/opt/zedbot}"
ZEDBOT_APP_DIR="${ZEDBOT_APP_DIR:-${ZEDBOT_BASE_DIR}/app}"
ZEDBOT_DATA_DIR="${ZEDBOT_DATA_DIR:-${ZEDBOT_BASE_DIR}/data}"
# HOST path of the backup directory. Deliberately independent of BACKUP_DIR:
# since the ops phase BACKUP_DIR (.env / compose environment) is the
# IN-CONTAINER mount path (/var/lib/zedbot/backups) and must never influence
# where backups live on the host. Relocate host backups by setting
# ZEDBOT_BACKUP_DIR (install.sh writes it into .env).
ZEDBOT_BACKUP_DIR="${ZEDBOT_BACKUP_DIR:-${ZEDBOT_BASE_DIR}/backups}"
ZEDBOT_LOGS_DIR="${ZEDBOT_LOGS_DIR:-${ZEDBOT_BASE_DIR}/logs}"
ZEDBOT_ENV_FILE_WAS_OVERRIDDEN=0
[ "${ZEDBOT_ENV_FILE+x}" = x ] && ZEDBOT_ENV_FILE_WAS_OVERRIDDEN=1
ZEDBOT_COMPOSE_CONTEXT_WAS_OVERRIDDEN=0
[ "${ZEDBOT_COMPOSE_CONTEXT+x}" = x ] && ZEDBOT_COMPOSE_CONTEXT_WAS_OVERRIDDEN=1
readonly _ZEDBOT_INITIAL_ENV_FILE_OVERRIDE="$ZEDBOT_ENV_FILE_WAS_OVERRIDDEN"
readonly _ZEDBOT_INITIAL_COMPOSE_CONTEXT_OVERRIDE="$ZEDBOT_COMPOSE_CONTEXT_WAS_OVERRIDDEN"
ZEDBOT_ENV_FILE="${ZEDBOT_ENV_FILE:-${ZEDBOT_APP_DIR}/.env}"
ZEDBOT_REPO_URL="${ZEDBOT_REPO_URL:-https://github.com/Mhoseinshah1/ZED_BOT.git}"
ZEDBOT_CLI_PATH="${ZEDBOT_CLI_PATH:-/usr/local/bin/zedbot}"
ZEDBOT_DEPLOYMENT_DIR="${ZEDBOT_DEPLOYMENT_DIR:-${ZEDBOT_BASE_DIR}/deployments}"
ZEDBOT_ROLLBACK_METADATA="${ZEDBOT_ROLLBACK_METADATA:-${ZEDBOT_DEPLOYMENT_DIR}/previous.json}"
ZEDBOT_FAILED_DEPLOYMENT_METADATA="${ZEDBOT_FAILED_DEPLOYMENT_METADATA:-${ZEDBOT_DEPLOYMENT_DIR}/failed.json}"
ZEDBOT_CURRENT_DEPLOYMENT_METADATA="${ZEDBOT_CURRENT_DEPLOYMENT_METADATA:-${ZEDBOT_DEPLOYMENT_DIR}/current.json}"
ZEDBOT_METADATA_TRANSITION="${ZEDBOT_METADATA_TRANSITION:-${ZEDBOT_DEPLOYMENT_DIR}/transition.json}"
ZEDBOT_OPERATION_STATE="${ZEDBOT_OPERATION_STATE:-${ZEDBOT_DEPLOYMENT_DIR}/operation-state.json}"
ZEDBOT_DEPLOYMENT_LOCK="${ZEDBOT_DEPLOYMENT_LOCK:-${ZEDBOT_DEPLOYMENT_DIR}/deployment.lock}"
ZEDBOT_BOT_RECREATION_BOUNDARY="${ZEDBOT_BOT_RECREATION_BOUNDARY:-${ZEDBOT_DEPLOYMENT_DIR}/bot-recreation.json}"
ZEDBOT_INSTALLATION_BOOTSTRAP="${ZEDBOT_INSTALLATION_BOOTSTRAP:-${ZEDBOT_DEPLOYMENT_DIR}/bootstrap.json}"
ZEDBOT_LEGACY_INSTALLATION="${ZEDBOT_LEGACY_INSTALLATION:-${ZEDBOT_DEPLOYMENT_DIR}/legacy-install-v1.json}"
ZEDBOT_DEPLOYMENT_LOCK_HELD=0
ZEDBOT_DEPLOYMENT_LOCK_ID=""
ZEDBOT_CANONICAL_REPO_URL="https://github.com/Mhoseinshah1/ZED_BOT.git"
reset_compose_fixed_identity() {
  _ZEDBOT_FIXED_PROJECT_DIR="/opt/zedbot/app"
  _ZEDBOT_FIXED_RUNTIME_ENV_FILE="/opt/zedbot/app/.env"
  _ZEDBOT_FIXED_PROJECT_NAME="zedbot"
  _ZEDBOT_FIXED_APPLICATION_IMAGE="zedbot-app:latest"
  _ZEDBOT_FIXED_DOCKER_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  ZEDBOT_CANONICAL_PROJECT_DIR="$_ZEDBOT_FIXED_PROJECT_DIR"
  ZEDBOT_CANONICAL_RUNTIME_ENV_FILE="$_ZEDBOT_FIXED_RUNTIME_ENV_FILE"
  ZEDBOT_COMPOSE_PROJECT_NAME="$_ZEDBOT_FIXED_PROJECT_NAME"
  ZEDBOT_EXPECTED_APPLICATION_IMAGE="$_ZEDBOT_FIXED_APPLICATION_IMAGE"
  ZEDBOT_EXPECTED_POSTGRES_IMAGE="postgres:16-alpine"
  ZEDBOT_EXPECTED_REDIS_IMAGE="redis:7-alpine"
  ZEDBOT_ENV_FILE="$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE"
  COMPOSE_CMD=(docker --context default compose)
}
reset_compose_fixed_identity
ZEDBOT_CANONICAL_COMPOSE_FILE="${ZEDBOT_CANONICAL_PROJECT_DIR}/docker-compose.yml"

set_deployment_state_paths() {
  ZEDBOT_DEPLOYMENT_DIR="$1"
  ZEDBOT_ROLLBACK_METADATA="$ZEDBOT_DEPLOYMENT_DIR/previous.json"
  ZEDBOT_FAILED_DEPLOYMENT_METADATA="$ZEDBOT_DEPLOYMENT_DIR/failed.json"
  ZEDBOT_CURRENT_DEPLOYMENT_METADATA="$ZEDBOT_DEPLOYMENT_DIR/current.json"
  ZEDBOT_METADATA_TRANSITION="$ZEDBOT_DEPLOYMENT_DIR/transition.json"
  ZEDBOT_OPERATION_STATE="$ZEDBOT_DEPLOYMENT_DIR/operation-state.json"
  ZEDBOT_DEPLOYMENT_LOCK="$ZEDBOT_DEPLOYMENT_DIR/deployment.lock"
  ZEDBOT_BOT_RECREATION_BOUNDARY="$ZEDBOT_DEPLOYMENT_DIR/bot-recreation.json"
  ZEDBOT_INSTALLATION_BOOTSTRAP="$ZEDBOT_DEPLOYMENT_DIR/bootstrap.json"
  ZEDBOT_LEGACY_INSTALLATION="$ZEDBOT_DEPLOYMENT_DIR/legacy-install-v1.json"
}

reset_deployment_state_fixed_identity() {
  set_deployment_state_paths /opt/zedbot/deployments
}

# --- Logging -----------------------------------------------------------------
if [ -t 1 ]; then
  _C_RESET=$'\033[0m'
  _C_BLUE=$'\033[1;34m'
  _C_GREEN=$'\033[1;32m'
  _C_YELLOW=$'\033[1;33m'
  _C_RED=$'\033[1;31m'
else
  _C_RESET=''
  _C_BLUE=''
  _C_GREEN=''
  _C_YELLOW=''
  _C_RED=''
fi

log_info()    { printf '%s[INFO]%s %s\n' "$_C_BLUE"   "$_C_RESET" "$*"; }
log_success() { printf '%s[ OK ]%s %s\n' "$_C_GREEN"  "$_C_RESET" "$*"; }
log_warn()    { printf '%s[WARN]%s %s\n' "$_C_YELLOW" "$_C_RESET" "$*" >&2; }
log_error()   { printf '%s[FAIL]%s %s\n' "$_C_RED"    "$_C_RESET" "$*" >&2; }

# --- Operation interruption and cleanup ------------------------------------
ZEDBOT_OPERATION_INTERRUPTED=0
ZEDBOT_OPERATION_SIGNAL_STATUS=0
ZEDBOT_OPERATION_CLEANUP_RUNNING=0
ZEDBOT_OPERATION_CLEANUP_DONE=0
ZEDBOT_OPERATION_ACTIVE_CHILD_PID=""
ZEDBOT_OPERATION_ACTIVE_CHILD_START=""
ZEDBOT_OPERATION_REGISTRY=""
ZEDBOT_OPERATION_REGISTRY_ID=""
ZEDBOT_OPERATION_REGISTRY_PARENT_ID=""
ZEDBOT_OPERATION_EXTRA_CLEANUP=""

operation_assert_active() {
  [ "$ZEDBOT_OPERATION_INTERRUPTED" -eq 0 ] || { log_error "Deployment operation was interrupted; refusing additional work."; return 1; }
}

operation_process_start() {
  local pid="$1" stat
  stat="$(<"/proc/$pid/stat")" 2>/dev/null || return 1
  stat="${stat##*) }"
  set -- $stat
  printf '%s\n' "${20:-}"
}

operation_child_is_owned() {
  local pid="$ZEDBOT_OPERATION_ACTIVE_CHILD_PID"
  [ -n "$pid" ] && [ -n "$ZEDBOT_OPERATION_ACTIVE_CHILD_START" ] && [ -r "/proc/$pid/stat" ] &&
    [ "$(operation_process_start "$pid" 2>/dev/null || true)" = "$ZEDBOT_OPERATION_ACTIVE_CHILD_START" ] &&
    [ "$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ]
}

operation_cleanup_pause() { sleep "$1"; }

terminate_owned_child() {
  local pid="$ZEDBOT_OPERATION_ACTIVE_CHILD_PID"
  [ -n "$pid" ] || return 0
  if operation_child_is_owned; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in 1 2 3 4; do
      operation_child_is_owned || break
      operation_cleanup_pause 0.25 || true
    done
    if operation_child_is_owned; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  fi
  wait "$pid" 2>/dev/null || true
  ZEDBOT_OPERATION_ACTIVE_CHILD_PID=""
  ZEDBOT_OPERATION_ACTIVE_CHILD_START=""
}

run_operation_child() {
  local rc
  operation_assert_active || return 1
  # Bash redirects an asynchronous command's stdin from /dev/null unless the
  # command has its own explicit redirection - the "(...) &" below counts as
  # one even when the CALLER piped/redirected real input into this function
  # (e.g. `run_compose exec ... pg_restore --list < dump.file`), silently
  # starving the child of that input. Save the inherited stdin on fd 8 in
  # this (non-backgrounded) parent context before forking, then have the
  # subshell explicitly restore it from there - only an explicit
  # redirection inside the async command itself is exempt from the
  # /dev/null substitution.
  exec 8<&0
  (
    exec 9>&- 2>/dev/null || true
    exec 0<&8 8<&-
    exec setsid -- "$@"
  ) &
  ZEDBOT_OPERATION_ACTIVE_CHILD_PID=$!
  exec 8<&-
  ZEDBOT_OPERATION_ACTIVE_CHILD_START="$(operation_process_start "$ZEDBOT_OPERATION_ACTIVE_CHILD_PID")" || {
    log_error "run_operation_child: could not read the start time of PID ${ZEDBOT_OPERATION_ACTIVE_CHILD_PID} (command: $*) - /proc/<pid>/stat was unavailable, so the child may have already exited."
    terminate_owned_child; return 1;
  }
  if wait "$ZEDBOT_OPERATION_ACTIVE_CHILD_PID"; then rc=0; else rc=$?; fi
  ZEDBOT_OPERATION_ACTIVE_CHILD_PID=""
  ZEDBOT_OPERATION_ACTIVE_CHILD_START=""
  if [ "$ZEDBOT_OPERATION_INTERRUPTED" -ne 0 ]; then
    log_error "run_operation_child: a signal was received while waiting on '$*' (child exit ${rc})."
    return "${ZEDBOT_OPERATION_SIGNAL_STATUS:-1}"
  fi
  return "$rc"
}

operation_register_artifact() {
  local path="$1" type="$2" id parent_id
  [ -n "$ZEDBOT_OPERATION_REGISTRY" ] && [ -f "$ZEDBOT_OPERATION_REGISTRY" ] || return 0
  [ -e "$path" ] && [ ! -L "$path" ] || return 1
  case "$type" in file) [ -f "$path" ] ;; dir) [ -d "$path" ] ;; *) return 1;; esac || return 1
  # Device, inode, and birth time bind cleanup to the exact object. Inode alone
  # is insufficient because an attacker can remove and rapidly recreate a file
  # at the same name and receive the recycled inode.
  id="$(stat -Lc '%d:%i:%w' "$path")" || return 1
  parent_id="$(stat -Lc '%d:%i' "${path%/*}")" || return 1
  printf '%s|%s|%s|%s\n' "$type" "$id" "$parent_id" "$path" >> "$ZEDBOT_OPERATION_REGISTRY"
}

operation_unregister_artifact() {
  # Cleanup is inode-bound, so leaving an already-removed registry entry is
  # safe and avoids a racy registry rewrite.
  return 0
}

operation_registry_is_owned() {
  [ -n "$ZEDBOT_OPERATION_REGISTRY" ] && [ -f "$ZEDBOT_OPERATION_REGISTRY" ] && [ ! -L "$ZEDBOT_OPERATION_REGISTRY" ] &&
    [ "$(stat -Lc '%d:%i' "$ZEDBOT_OPERATION_REGISTRY" 2>/dev/null || true)" = "$ZEDBOT_OPERATION_REGISTRY_ID" ] &&
    [ "$(stat -Lc '%d:%i' "${ZEDBOT_OPERATION_REGISTRY%/*}" 2>/dev/null || true)" = "$ZEDBOT_OPERATION_REGISTRY_PARENT_ID" ]
}

operation_mktemp() {
  local path
  path="$(mktemp "$1")" || return 1
  operation_register_artifact "$path" file || { rm -f -- "$path"; return 1; }
  printf '%s\n' "$path"
}

operation_mktemp_dir() {
  local path
  path="$(mktemp -d "$1")" || return 1
  operation_register_artifact "$path" dir || { rmdir -- "$path"; return 1; }
  printf '%s\n' "$path"
}

operation_cleanup_artifacts() {
  local type id parent_id path actual parent_actual rc=0
  [ -z "$ZEDBOT_OPERATION_REGISTRY" ] && return 0
  operation_registry_is_owned || return 1
  while IFS='|' read -r type id parent_id path; do
    [ -n "$path" ] || continue
    [ ! -L "$path" ] || { rc=1; continue; }
    [ -e "$path" ] || continue
    actual="$(stat -Lc '%d:%i:%w' "$path" 2>/dev/null || true)"; parent_actual="$(stat -Lc '%d:%i' "${path%/*}" 2>/dev/null || true)"
    [ "$actual" = "$id" ] && [ "$parent_actual" = "$parent_id" ] || { rc=1; continue; }
    case "$type" in file) [ -f "$path" ] && rm -f -- "$path" || rc=1 ;; dir) [ -d "$path" ] && rmdir -- "$path" 2>/dev/null || rc=1 ;; *) rc=1;; esac
  done < "$ZEDBOT_OPERATION_REGISTRY"
  return "$rc"
}

operation_cleanup() {
  local primary_rc="${1:-1}" cleanup_rc=0
  [ "$ZEDBOT_OPERATION_CLEANUP_DONE" -eq 0 ] || return 0
  [ "$ZEDBOT_OPERATION_CLEANUP_RUNNING" -eq 0 ] || return 1
  ZEDBOT_OPERATION_CLEANUP_RUNNING=1
  terminate_owned_child || cleanup_rc=1
  if [ -n "$ZEDBOT_OPERATION_EXTRA_CLEANUP" ]; then "$ZEDBOT_OPERATION_EXTRA_CLEANUP" || cleanup_rc=1; fi
  operation_cleanup_artifacts || cleanup_rc=1
  if [ "$ZEDBOT_DEPLOYMENT_LOCK_HELD" -eq 1 ]; then release_deployment_lock || cleanup_rc=1; fi
  if [ -n "$ZEDBOT_OPERATION_REGISTRY" ]; then
    if operation_registry_is_owned; then rm -f -- "$ZEDBOT_OPERATION_REGISTRY" || cleanup_rc=1; else cleanup_rc=1; fi
  fi
  ZEDBOT_OPERATION_CLEANUP_DONE=1
  ZEDBOT_OPERATION_CLEANUP_RUNNING=0
  [ "$primary_rc" -ne 0 ] && return 0
  return "$cleanup_rc"
}

operation_signal_handler() {
  local name="$1" status="$2"
  if [ "$ZEDBOT_OPERATION_INTERRUPTED" -eq 0 ]; then
    ZEDBOT_OPERATION_INTERRUPTED=1
    ZEDBOT_OPERATION_SIGNAL_STATUS="$status"
    log_error "Deployment operation interrupted by ${name}."
  fi
  terminate_owned_child || true
  exit "$ZEDBOT_OPERATION_SIGNAL_STATUS"
}

operation_exit_handler() {
  local primary_rc=$? final_rc
  trap - EXIT ERR INT TERM HUP
  trap '' INT TERM HUP
  final_rc="$primary_rc"
  operation_cleanup "$primary_rc" || { [ "$final_rc" -ne 0 ] || final_rc=1; }
  [ "$ZEDBOT_OPERATION_INTERRUPTED" -eq 0 ] || final_rc="$ZEDBOT_OPERATION_SIGNAL_STATUS"
  exit "$final_rc"
}

install_operation_traps() {
  local extra_cleanup="${1:-}"
  [ -z "$ZEDBOT_OPERATION_REGISTRY" ] || return 1
  ZEDBOT_OPERATION_EXTRA_CLEANUP="$extra_cleanup"
  ZEDBOT_OPERATION_REGISTRY="$(mktemp "${TMPDIR:-/tmp}/zedbot-operation.$$.XXXXXXXX")" || return 1
  chmod 600 "$ZEDBOT_OPERATION_REGISTRY" || return 1
  ZEDBOT_OPERATION_REGISTRY_ID="$(stat -Lc '%d:%i' "$ZEDBOT_OPERATION_REGISTRY")" || return 1
  ZEDBOT_OPERATION_REGISTRY_PARENT_ID="$(stat -Lc '%d:%i' "${ZEDBOT_OPERATION_REGISTRY%/*}")" || return 1
  trap operation_exit_handler EXIT
  trap 'operation_signal_handler SIGINT 130' INT
  trap 'operation_signal_handler SIGTERM 143' TERM
  trap 'operation_signal_handler SIGHUP 129' HUP
}

# --- Small utilities ---------------------------------------------------------
has_command() { command -v "$1" >/dev/null 2>&1; }

timestamp() { date +%Y%m%d-%H%M%S; }

# Strip leading/trailing shell whitespace (space, tab, CR, newline) from a value
# WITHOUT eval, without logging/printing it to output, and without exposing its
# length, prefix, suffix, or hash - and interior characters are left untouched.
# Mirrors the runtime resolver's value.trim() (packages/shared/src/telegram-token.ts)
# so a whitespace-only token reads as unset in exactly the same way. Returns the
# trimmed value via stdout (captured with $(...), like the other value helpers) -
# it is never echoed to a log. The dependency-free scripts/validate-env.sh keeps
# a behaviourally identical inline copy; a source-parity test keeps the two in sync.
trim_env_token_value() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}" # strip leading whitespace
  v="${v%"${v##*[![:space:]]}"}" # strip trailing whitespace
  printf '%s' "$v"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "This command must be run as root (try again with sudo)."
    exit 1
  fi
}

require_ubuntu() {
  local os_id os_version os_pretty
  if [ ! -r /etc/os-release ]; then
    log_error "Cannot detect the operating system. ZED_BOT supports Ubuntu 24.04 and 26.04."
    exit 1
  fi
  os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  os_pretty="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  if [ "$os_id" != "ubuntu" ]; then
    log_error "Unsupported OS: ${os_pretty}. ZED_BOT supports Ubuntu 24.04 and 26.04."
    exit 1
  fi
  case "$os_version" in
    24.04 | 26.04)
      log_info "Detected supported OS: ${os_pretty}"
      ;;
    22.04)
      log_warn "Detected ${os_pretty}. Ubuntu 22.04 is supported on a best-effort basis only; the primary targets are 24.04 and 26.04."
      ;;
    *)
      log_warn "Detected ${os_pretty}. Primary supported versions: Ubuntu 24.04 / 26.04. Continuing anyway."
      ;;
  esac
}

ensure_directory() {
  local dir="$1" mode="${2:-}"
  mkdir -p "$dir"
  if [ -n "$mode" ]; then
    chmod "$mode" "$dir"
  fi
}

# Makes the host backup directory usable by the containers: the bot mounts it
# read-only and the worker read-write, both running as the unprivileged image
# user (node, UID/GID 1000 unless overridden via ZEDBOT_RUNTIME_UID/GID).
# Idempotent repair: mkdir -p + chown + chmod 750. It NEVER deletes anything
# and never widens permissions beyond 750 (no world access, ever).
ensure_backup_dir_permissions() {
  local dir="${1:-$ZEDBOT_BACKUP_DIR}"
  local uid="${ZEDBOT_RUNTIME_UID:-1000}" gid="${ZEDBOT_RUNTIME_GID:-1000}"
  mkdir -p "$dir"
  chown "${uid}:${gid}" "$dir"
  chmod 750 "$dir"
  # Database backup files must be readable by the runtime user (the worker
  # delivers them to Telegram; the bot lists them through its ro mount).
  # Only zedbot-db-* files are touched: the update safety archives
  # (zedbot_backup_*.tar.gz, they contain .env) stay root-owned with 600.
  find "$dir" -maxdepth 1 -type f -name 'zedbot-db-*' \
    -exec chown "${uid}:${gid}" {} + -exec chmod 640 {} + 2>/dev/null || true
}

generate_password() {
  # Hex output only: safe in the shell, in .env files and in connection URLs.
  if has_command openssl; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# --- Docker Compose ----------------------------------------------------------
COMPOSE_CMD=(docker --context default compose)

clean_docker_environment() {
  run_operation_child /usr/bin/env -i PATH="$_ZEDBOT_FIXED_DOCKER_PATH" LC_ALL=C COMPOSE_DISABLE_ENV_FILE=1 "$@"
}

run_clean_docker() {
  clean_docker_environment docker --context default "$@"
}

detect_compose_command() {
  if ! clean_docker_environment "${COMPOSE_CMD[@]}" version >/dev/null 2>&1; then
    log_error "Docker Compose v2 is not installed. Run the ZED_BOT installer first."
    return 1
  fi
}

app_cd() {
  if [ ! -d "$ZEDBOT_APP_DIR" ]; then
    log_error "Application directory not found: ${ZEDBOT_APP_DIR}"
    log_error "Install ZED_BOT first:"
    log_error "  bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)"
    exit 1
  fi
  cd "$ZEDBOT_APP_DIR"
}

validate_compose_contract_paths() {
  [ "$_ZEDBOT_INITIAL_ENV_FILE_OVERRIDE" -eq 0 ] || { log_error "ZEDBOT_ENV_FILE override is forbidden for deployment Compose."; return 1; }
  [ "$_ZEDBOT_INITIAL_COMPOSE_CONTEXT_OVERRIDE" -eq 0 ] || { log_error "ZEDBOT_COMPOSE_CONTEXT override is forbidden for deployment Compose."; return 1; }
  [ "$ZEDBOT_CANONICAL_PROJECT_DIR" = "$_ZEDBOT_FIXED_PROJECT_DIR" ] &&
    [ "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" = "$_ZEDBOT_FIXED_RUNTIME_ENV_FILE" ] &&
    [ "$ZEDBOT_COMPOSE_PROJECT_NAME" = "$_ZEDBOT_FIXED_PROJECT_NAME" ] &&
    [ "$ZEDBOT_EXPECTED_APPLICATION_IMAGE" = "$_ZEDBOT_FIXED_APPLICATION_IMAGE" ] || { log_error "Fixed Compose identity was redirected."; return 1; }
  [ "$ZEDBOT_CANONICAL_PROJECT_DIR" = "$(/usr/bin/realpath -e -- "$ZEDBOT_CANONICAL_PROJECT_DIR" 2>/dev/null)" ] && [ -d "$ZEDBOT_CANONICAL_PROJECT_DIR" ] && [ ! -L "$ZEDBOT_CANONICAL_PROJECT_DIR" ] || {
    log_error "Canonical Compose project directory is missing or redirected."; return 1;
  }
  [ -f "$ZEDBOT_CANONICAL_COMPOSE_FILE" ] && [ ! -L "$ZEDBOT_CANONICAL_COMPOSE_FILE" ] || { log_error "Canonical Compose file is missing, symlinked, or not regular."; return 1; }
  [ -f "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" ] && [ ! -L "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" ] || { log_error "Canonical runtime env file is missing, symlinked, or not regular."; return 1; }
  [ "$ZEDBOT_ENV_FILE" = "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" ] || { log_error "Runtime env-file path was redirected."; return 1; }
}

set_update_compose_contract() {
  local snapshot="$1" sha="$2" tree="$3"
  require_source_integrity "$sha" "$tree" "$snapshot" || return 1
  register_source_snapshot "$snapshot" "$sha" "$tree" || return 1
  ZEDBOT_CANONICAL_COMPOSE_FILE="$snapshot/docker-compose.yml"
  validate_compose_contract_paths
}

set_rollback_compose_contract() {
  local evidence_root="$1" expected_sha256="$2" file
  file="$evidence_root/docker-compose.yml"
  [ -f "$file" ] && [ ! -L "$file" ] || { log_error "Generation Compose evidence is unavailable."; return 1; }
  [ "$(/usr/bin/sha256sum "$file" | /usr/bin/awk '{print $1}')" = "$expected_sha256" ] || { log_error "Generation Compose evidence checksum differs."; return 1; }
  ZEDBOT_CANONICAL_COMPOSE_FILE="$file"
  validate_compose_contract_paths
}

# Runs one fixed Compose contract without current-directory or ambient-control
# resolution. The explicit env file is for interpolation and service env_file.
run_compose() {
  detect_compose_command || return 1
  validate_compose_contract_paths || return 1
  clean_docker_environment "${COMPOSE_CMD[@]}" --project-directory "$ZEDBOT_CANONICAL_PROJECT_DIR" \
      -f "$ZEDBOT_CANONICAL_COMPOSE_FILE" \
      --project-name "$ZEDBOT_COMPOSE_PROJECT_NAME" \
      --env-file "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" "$@"
}

# Compose interpolation normally receives no ambient environment at all. A
# build is the one exception: its immutable deployment identity must reach the
# Dockerfile as a build argument. Keep that exception narrow and validate it
# before adding only GIT_SHA to the otherwise-clean environment.
run_compose_with_deployment_sha() {
  local sha="$1"
  shift
  valid_git_sha "$sha" || { log_error "Deployment image SHA is invalid."; return 1; }
  detect_compose_command || return 1
  validate_compose_contract_paths || return 1
  run_operation_child /usr/bin/env -i PATH="$_ZEDBOT_FIXED_DOCKER_PATH" LC_ALL=C \
    COMPOSE_DISABLE_ENV_FILE=1 GIT_SHA="$sha" \
    "${COMPOSE_CMD[@]}" --project-directory "$ZEDBOT_CANONICAL_PROJECT_DIR" \
      -f "$ZEDBOT_CANONICAL_COMPOSE_FILE" \
      --project-name "$ZEDBOT_COMPOSE_PROJECT_NAME" \
      --env-file "$ZEDBOT_CANONICAL_RUNTIME_ENV_FILE" "$@"
}

# Read-only, fail-closed running-state observation shared by doctor and backup
# commands. Never accepts an arbitrary Compose service or container identity.
compose_service_running() {
  local service="$1" cid inspection
  case "$service" in api|bot|worker|postgres|redis) ;; *) return 1;; esac
  cid="$(run_compose ps -q "$service" 2>/dev/null | /usr/bin/head -n 1 || true)"
  [ -n "$cid" ] || return 1
  inspection="$(run_clean_docker inspect --type container "$cid" 2>/dev/null)" || return 1
  printf '%s' "$inspection" | /usr/bin/jq -e --arg service "$service" --arg project "$ZEDBOT_COMPOSE_PROJECT_NAME" '
    type=="array" and length==1 and
    .[0].State.Running==true and
    .[0].Config.Labels["com.docker.compose.project"]==$project and
    .[0].Config.Labels["com.docker.compose.service"]==$service
  ' >/dev/null 2>&1
}

validate_compose_application_images() {
  local rendered service image image_occurrences
  rendered="$(run_compose config --format json)" || { log_error "Canonical Compose configuration could not be rendered."; return 1; }
  printf '%s' "$rendered" | /usr/bin/jq -e --arg project "$ZEDBOT_COMPOSE_PROJECT_NAME" 'type=="object" and .name==$project and (.services|type=="object")' >/dev/null 2>&1 || { log_error "Rendered Compose project identity or services structure is invalid."; return 1; }
  for service in api bot worker; do
    image_occurrences="$(printf '%s' "$rendered" | /usr/bin/jq --stream -nr --arg s "$service" \
      '[inputs | select(length==2 and .[0]==["services",$s,"image"])] | length')" || {
      log_error "Rendered Compose service ${service} cannot be parsed safely."; return 1;
    }
    [ "$image_occurrences" = 1 ] || { log_error "Rendered Compose service ${service} has a missing or duplicate image identity."; return 1; }
    image="$(printf '%s' "$rendered" | /usr/bin/jq -er --arg s "$service" '.services[$s] | select(type=="object") | .image | select(type=="string" and length>0)')" || {
      log_error "Rendered Compose service ${service} is missing or has no image identity."; return 1;
    }
    [ "$image" = "$ZEDBOT_EXPECTED_APPLICATION_IMAGE" ] || { log_error "Rendered Compose service ${service} has an unexpected image reference."; return 1; }
  done
}

validate_compose_readiness_contract() {
  local rendered service expected image occurrences
  rendered="$(run_compose config --format json)" || { log_error "Canonical Compose readiness configuration could not be rendered."; return 1; }
  printf '%s' "$rendered" | /usr/bin/jq -e --arg project "$ZEDBOT_COMPOSE_PROJECT_NAME" \
    'type=="object" and .name==$project and (.services|type=="object")' >/dev/null 2>&1 || {
      log_error "Rendered Compose readiness project or services structure is invalid."; return 1;
    }
  for service in postgres redis api bot worker; do
    case "$service" in
      postgres) expected="$ZEDBOT_EXPECTED_POSTGRES_IMAGE" ;;
      redis) expected="$ZEDBOT_EXPECTED_REDIS_IMAGE" ;;
      *) expected="$ZEDBOT_EXPECTED_APPLICATION_IMAGE" ;;
    esac
    occurrences="$(printf '%s' "$rendered" | /usr/bin/jq --stream -nr --arg s "$service" \
      '[inputs | select(length==2 and .[0]==["services",$s,"image"])] | length')" || return 1
    [ "$occurrences" = 1 ] || { log_error "Readiness service ${service} has a missing or duplicate image declaration."; return 1; }
    image="$(printf '%s' "$rendered" | /usr/bin/jq -er --arg s "$service" \
      '.services[$s] | select(type=="object") | .image | select(type=="string" and length>0)')" || return 1
    [ "$image" = "$expected" ] || { log_error "Readiness service ${service} has an unexpected image reference."; return 1; }
  done
}

recreate_application_services() {
  validate_compose_application_images || return 1
  run_compose up -d --no-deps --no-build --pull never --force-recreate api bot worker
}

readiness_now() { date +%s; }
readiness_pause() { sleep "$1"; }

# Tests replace this function with deterministic evidence. The production
# implementation obtains a fresh, single-container inspection for every
# required service; command failure is never hidden by a successful parse.
collect_readiness_evidence() {
  local kind="$1" attempt="$2" observed="$3" expected_sha="${4:-}" service ids cid inspection health generation
  local services=(postgres redis) records='[]'
  [ "$kind" = application ] && services=(api bot worker)
  for service in "${services[@]}"; do
    # docker compose ps has no general label filter, and "docker compose run"
    # tags its container with the SAME service label as the long-running one
    # from "up -d" - only the "oneoff" label tells them apart. Filtering on
    # it directly through docker (not compose) means a leftover run --rm
    # container (e.g. left behind by a killed migration-status/preflight
    # invocation) can never masquerade as a second instance of this service
    # and permanently break the exactly-one-container invariant below.
    ids="$(run_clean_docker ps -aq \
      --filter "label=com.docker.compose.project=$ZEDBOT_COMPOSE_PROJECT_NAME" \
      --filter "label=com.docker.compose.service=$service" \
      --filter "label=com.docker.compose.oneoff=False")" || return 1
    [ "$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d' | /usr/bin/wc -l)" -eq 1 ] || return 1
    cid="$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d')"
    inspection="$(run_clean_docker inspect "$cid")" || return 1
    printf '%s' "$inspection" | /usr/bin/jq -e 'type=="array" and length==1 and (.[0]|type=="object")' >/dev/null 2>&1 || return 1
    health="$(printf '%s' "$inspection" | /usr/bin/jq -r '.[0].State.Health.Status // "missing"')"
    if [ "$kind" = application ]; then
      case "$service" in
        worker) check_fresh_worker_heartbeat && health=healthy || health=starting ;;
      esac
    fi
    generation="$(printf '%s' "$inspection" | /usr/bin/jq -r '[.[0].Config.Env[]? | select(startswith("GIT_SHA=")) | ltrimstr("GIT_SHA=")] | if length==1 then .[0] else "" end')"
    records="$(printf '%s' "$inspection" | /usr/bin/jq -c --argjson records "$records" --arg service "$service" --arg health "$health" --arg generation "$generation" '
      $records + [{service:$service,containerId:.[0].Id,imageId:.[0].Image,imageRef:.[0].Config.Image,
        project:(.[0].Config.Labels["com.docker.compose.project"] // ""), declaredService:(.[0].Config.Labels["com.docker.compose.service"] // ""),
        status:.[0].State.Status,health:$health,restartCount:.[0].RestartCount,generation:$generation}]')" || return 1
  done
  /usr/bin/jq -cn --arg kind "$kind" --arg attempt "$attempt" --argjson observed "$observed" --argjson services "$records" \
    '{formatVersion:1,kind:$kind,attempt:$attempt,observedAt:$observed,services:$services}'
}

# Returns 0 ready, 1 retryable (only missing/starting), or 2 terminal failure.
evaluate_readiness_evidence() {
  local evidence="$1" kind="$2" attempt="$3" started="$4" now="$5" expected_image_id="${6:-}" expected_sha="${7:-}"
  local required refs
  case "$kind" in
    dependency) required='["postgres","redis"]'; refs='{"postgres":"postgres:16-alpine","redis":"redis:7-alpine"}' ;;
    application) required='["api","bot","worker"]'; refs='{"api":"zedbot-app:latest","bot":"zedbot-app:latest","worker":"zedbot-app:latest"}' ;;
    *) return 2 ;;
  esac
  printf '%s' "$evidence" | /usr/bin/jq -e --arg kind "$kind" --arg attempt "$attempt" --argjson started "$started" --argjson now "$now" \
    --arg image "$expected_image_id" --arg sha "$expected_sha" --argjson required "$required" --argjson refs "$refs" '
    type=="object" and keys==["attempt","formatVersion","kind","observedAt","services"] and .formatVersion==1 and
    .kind==$kind and .attempt==$attempt and (.observedAt|type=="number") and .observedAt >= $started and .observedAt <= $now and ($now-.observedAt)<=5 and
    (.services|type=="array") and ([.services[].service]|sort)==($required|sort) and
    ([.services[].service]|unique|length)==($required|length) and ([.services[].containerId]|unique|length)==($required|length) and
    all(.services[]; type=="object" and keys==["containerId","declaredService","generation","health","imageId","imageRef","project","restartCount","service","status"] and
      (.service|type=="string") and (.containerId|type=="string" and length>0) and .declaredService==.service and .project=="zedbot" and
      (.imageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and .imageRef==$refs[.service] and
      (.status|type=="string") and (.health|type=="string") and (.restartCount|type=="number" and .==0) and
      (if $kind=="application" then .imageId==$image and .generation==$sha else .generation=="" end))
  ' >/dev/null 2>&1 || return 2
  if printf '%s' "$evidence" | /usr/bin/jq -e 'all(.services[]; .status=="running" and .health=="healthy")' >/dev/null; then return 0; fi
  if printf '%s' "$evidence" | /usr/bin/jq -e '
    all(.services[];
      (.status=="running" and .health=="healthy") or
      ((.status=="running" or .status=="created") and (.health=="starting" or .health=="missing"))) and
    any(.services[]; .status!="running" or .health!="healthy")
  ' >/dev/null; then return 1; fi
  return 2
}

wait_for_readiness_policy() {
  local kind="$1" attempt="$2" expected_image_id="${3:-}" expected_sha="${4:-}" timeout="${5:-90}" interval="${6:-3}"
  local started now evidence rc
  [[ "$timeout" =~ ^[1-9][0-9]*$ && "$interval" =~ ^[1-9][0-9]*$ ]] || return 1
  validate_compose_readiness_contract || return 1
  started="$(readiness_now)" || return 1
  while :; do
    operation_assert_active || return 1
    now="$(readiness_now)" || return 1
    [ "$now" -le $((started + timeout)) ] || { log_error "${kind} readiness timed out."; return 1; }
    evidence="$(collect_readiness_evidence "$kind" "$attempt" "$now" "$expected_sha")" || { log_error "${kind} readiness inspection failed."; return 1; }
    if evaluate_readiness_evidence "$evidence" "$kind" "$attempt" "$started" "$now" "$expected_image_id" "$expected_sha"; then rc=0; else rc=$?; fi
    case "$rc" in 0) return 0 ;; 2) log_error "${kind} readiness evidence is terminal, malformed, stale, contradictory, or identity-mismatched."; return 1 ;; esac
    [ $((now + interval)) -le $((started + timeout)) ] || { log_error "${kind} readiness timed out."; return 1; }
    readiness_pause "$interval" || { log_error "${kind} readiness was cancelled or interrupted."; return 1; }
  done
}

current_readiness_attempt() {
  if validate_operation_state "$ZEDBOT_OPERATION_STATE" >/dev/null 2>&1; then
    /usr/bin/jq -r '.kind+":"+.generation+":"+.stage' "$ZEDBOT_OPERATION_STATE"
    return
  fi
  validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current >/dev/null 2>&1 || return 1
  /usr/bin/jq -r '"preflight:"+.generation+":current-validated"' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA"
}

validate_dependencies_healthy() {
  local attempt
  attempt="$(current_readiness_attempt)" || { log_error "Dependency readiness requires a valid locked operation state."; return 1; }
  require_deployment_lock || return 1
  wait_for_readiness_policy dependency "$attempt" "" "" 30 3
}

validate_deployment_path_contract() {
  local path component current="" expected
  case "$ZEDBOT_DEPLOYMENT_DIR" in /*) ;; *) log_error "Deployment-state directory must be an absolute canonical path."; return 1;; esac
  case "$ZEDBOT_DEPLOYMENT_DIR" in *'/../'*|*'/./'*|*'//'*) log_error "Deployment-state directory contains an unsafe spelling."; return 1;; esac
  [ "$ZEDBOT_DEPLOYMENT_DIR" = "${ZEDBOT_DEPLOYMENT_DIR%/}" ] || { log_error "Deployment-state directory must not have a trailing slash."; return 1; }
  [ "$ZEDBOT_ROLLBACK_METADATA" = "$ZEDBOT_DEPLOYMENT_DIR/previous.json" ] &&
    [ "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" = "$ZEDBOT_DEPLOYMENT_DIR/failed.json" ] &&
    [ "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" = "$ZEDBOT_DEPLOYMENT_DIR/current.json" ] &&
    [ "$ZEDBOT_METADATA_TRANSITION" = "$ZEDBOT_DEPLOYMENT_DIR/transition.json" ] &&
    [ "$ZEDBOT_OPERATION_STATE" = "$ZEDBOT_DEPLOYMENT_DIR/operation-state.json" ] &&
    [ "$ZEDBOT_DEPLOYMENT_LOCK" = "$ZEDBOT_DEPLOYMENT_DIR/deployment.lock" ] &&
    [ "$ZEDBOT_BOT_RECREATION_BOUNDARY" = "$ZEDBOT_DEPLOYMENT_DIR/bot-recreation.json" ] &&
    [ "$ZEDBOT_INSTALLATION_BOOTSTRAP" = "$ZEDBOT_DEPLOYMENT_DIR/bootstrap.json" ] &&
    [ "$ZEDBOT_LEGACY_INSTALLATION" = "$ZEDBOT_DEPLOYMENT_DIR/legacy-install-v1.json" ] || {
      log_error "Deployment state paths do not match the canonical state contract."; return 1;
    }
  IFS=/ read -r -a _state_components <<< "${ZEDBOT_DEPLOYMENT_DIR#/}"
  for component in "${_state_components[@]}"; do
    [ -n "$component" ] && [ "$component" != . ] && [ "$component" != .. ] || return 1
    current="$current/$component"
    if [ -e "$current" ] || [ -L "$current" ]; then
      [ ! -L "$current" ] || { log_error "Deployment-state path contains a symlink: $current"; return 1; }
      [ -d "$current" ] || { log_error "Deployment-state path component is not a directory: $current"; return 1; }
    fi
  done
}

validate_canonical_state_destination() {
  local destination="$1" base
  validate_deployment_path_contract || return 1
  base="${destination##*/}"
  [ "${destination%/*}" = "$ZEDBOT_DEPLOYMENT_DIR" ] || { log_error "State destination is outside the canonical directory."; return 1; }
  case "$base" in
    previous.json|failed.json|current.json|transition.json|operation-state.json|bot-recreation.json|bootstrap.json|legacy-install-v1.json|deployment.lock) ;;
    candidate-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9].json) ;;
    *) log_error "State destination name is not permitted: $base"; return 1;;
  esac
}

validate_state_regular_file() {
  local file="$1"
  validate_canonical_state_destination "$file" || return 1
  [ -e "$file" ] && [ ! -L "$file" ] && [ -f "$file" ] || { log_error "State file is missing, symlinked, or not regular."; return 1; }
  [ "$(stat -c %u:%a "$file")" = "0:600" ] || { log_error "State file must be root-owned with mode 600."; return 1; }
}

# --- Installation identity and legacy conversion (Area 10) -----------------
# Installation identity is derived only from canonical, schema-validated state.
# Container/tag/environment/timestamp observations are deliberately irrelevant.
# shellcheck disable=SC2120  # every call site uses the canonical default; the
# override parameter exists so a future/test caller can validate an arbitrary
# bootstrap-evidence file without duplicating the schema check.
validate_installation_bootstrap() {
  local file="${1:-$ZEDBOT_INSTALLATION_BOOTSTRAP}"
  validate_state_regular_file "$file" || return 1
  /usr/bin/jq -e '
    type=="object" and
    keys==["formatVersion","generation","kind","operation","phase","sourceSha","sourceTree"] and
    .formatVersion==1 and (.kind|IN("first-install","legacy-upgrade")) and
    (.operation|type=="string" and test("^[a-f0-9-]{36}$")) and
    (.generation|type=="string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    (.sourceSha|type=="string" and test("^[a-f0-9]{40}$")) and
    (.sourceTree|type=="string" and test("^[a-f0-9]{40}$")) and
    (.phase|IN("initialized","canonical-published","health-confirmed","promoted"))
  ' "$file" >/dev/null || { log_error "Installation bootstrap metadata is malformed or unsupported."; return 1; }
}

validate_supported_legacy_installation() {
  validate_state_regular_file "$ZEDBOT_LEGACY_INSTALLATION" || return 1
  validate_generation_metadata_core "$ZEDBOT_LEGACY_INSTALLATION" current || {
    log_error "Only the allowlisted legacy-v1 complete known-good generation format is supported."; return 1;
  }
  validate_generation_owned_evidence "$ZEDBOT_LEGACY_INSTALLATION" || return 1
}

installation_nonlock_entries() {
  local entry
  shopt -s nullglob dotglob
  for entry in "$ZEDBOT_DEPLOYMENT_DIR"/*; do
    [ "${entry##*/}" = deployment.lock ] || printf '%s\n' "${entry##*/}"
  done
  shopt -u nullglob dotglob
}

validate_existing_installation_auxiliary() {
  local entry base role
  shopt -s nullglob dotglob
  for entry in "$ZEDBOT_DEPLOYMENT_DIR"/*; do
    base="${entry##*/}"
    case "$base" in
      deployment.lock|current.json) ;;
      previous.json) validate_generation_metadata_core "$entry" previous || { shopt -u nullglob dotglob; return 1; } ;;
      failed.json) validate_generation_metadata_core "$entry" failed || { shopt -u nullglob dotglob; return 1; } ;;
      candidate-*.json) validate_generation_metadata_core "$entry" candidate || { shopt -u nullglob dotglob; return 1; } ;;
      operation-state.json) validate_operation_state "$entry" || { shopt -u nullglob dotglob; return 1; } ;;
      transition.json) validate_state_regular_file "$entry" || { shopt -u nullglob dotglob; return 1; } ;;
      bot-recreation.json) validate_state_regular_file "$entry" || { shopt -u nullglob dotglob; return 1; } ;;
      bootstrap.json|legacy-install-v1.json) ;;
      evidence-*) [ -d "$entry" ] && [ ! -L "$entry" ] || { shopt -u nullglob dotglob; return 1; } ;;
      *) log_error "Unexpected installation artifact makes canonical identity ambiguous: $base"; shopt -u nullglob dotglob; return 1;;
    esac
  done
  shopt -u nullglob dotglob
}

classify_installation() {
  local intent="${1:-observe}" entries
  validate_deployment_path_contract || return 1
  if [ ! -e "$ZEDBOT_DEPLOYMENT_DIR" ]; then
    [ "$intent" = first-install ] && { printf '%s\n' genuine-first-install; return 0; }
    log_error "No canonical installation evidence exists; explicit first-install initialization is required."; return 1
  fi
  [ -d "$ZEDBOT_DEPLOYMENT_DIR" ] && [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ] || return 1
  entries="$(installation_nonlock_entries)" || return 1
  if [ -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] || [ -L "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ]; then
    validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
    validate_generation_owned_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
    validate_existing_installation_auxiliary || return 1
    if [ -e "$ZEDBOT_INSTALLATION_BOOTSTRAP" ] || [ -L "$ZEDBOT_INSTALLATION_BOOTSTRAP" ]; then
      validate_installation_bootstrap || return 1
      [ "$(/usr/bin/jq -r .phase "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = promoted ] &&
        [ "$(/usr/bin/jq -r .generation "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = "$(/usr/bin/jq -r .generation "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")" ] || {
          log_error "Canonical metadata conflicts with incomplete bootstrap identity."; return 1;
        }
    fi
    if [ -e "$ZEDBOT_LEGACY_INSTALLATION" ] || [ -L "$ZEDBOT_LEGACY_INSTALLATION" ]; then
      validate_supported_legacy_installation || return 1
      validate_installation_bootstrap || return 1
      [ "$(/usr/bin/jq -r '.kind+":"+.phase' "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = legacy-upgrade:promoted ] &&
        [ "$(/usr/bin/jq -r .generation "$ZEDBOT_LEGACY_INSTALLATION")" = "$(/usr/bin/jq -r .generation "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")" ] || {
          log_error "Canonical and legacy installation evidence coexist without a completed matching conversion."; return 1;
        }
    fi
    printf '%s\n' existing-canonical; return 0
  fi
  if [ -e "$ZEDBOT_INSTALLATION_BOOTSTRAP" ] || [ -L "$ZEDBOT_INSTALLATION_BOOTSTRAP" ]; then
    validate_installation_bootstrap || return 1
    case "$entries" in bootstrap.json|$'bootstrap.json\noperation-state.json'|$'operation-state.json\nbootstrap.json') ;;
      *) log_error "Bootstrap metadata conflicts with other installation evidence."; return 1;; esac
    printf '%s\n' recoverable-bootstrap; return 0
  fi
  if [ -e "$ZEDBOT_LEGACY_INSTALLATION" ] || [ -L "$ZEDBOT_LEGACY_INSTALLATION" ]; then
    [ "$entries" = legacy-install-v1.json ] || { log_error "Legacy evidence is mixed with another installation identity."; return 1; }
    validate_supported_legacy_installation || return 1
    printf '%s\n' supported-legacy; return 0
  fi
  if [ -z "$entries" ] && [ "$intent" = first-install ]; then printf '%s\n' genuine-first-install; return 0; fi
  log_error "Installation evidence is absent, partial, ambiguous, or unsupported; refusing to infer first install."
  return 1
}

begin_installation_bootstrap() {
  local kind="$1" generation="$2" source_sha="$3" source_tree="$4" operation="$5" tmp classification
  operation_assert_active || return 1
  require_deployment_lock || return 1
  classification="$(classify_installation "$([ "$kind" = first-install ] && echo first-install || echo observe)")" || return 1
  case "$kind:$classification" in first-install:genuine-first-install|legacy-upgrade:supported-legacy) ;; *) return 1;; esac
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.bootstrap.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg kind "$kind" --arg generation "$generation" --arg operation "$operation" --arg sourceSha "$source_sha" --arg sourceTree "$source_tree" \
    '{formatVersion:1,kind:$kind,generation:$generation,operation:$operation,phase:"initialized",sourceSha:$sourceSha,sourceTree:$sourceTree}' > "$tmp" || { rm -f "$tmp"; return 1; }
  atomic_write_metadata "$tmp" "$ZEDBOT_INSTALLATION_BOOTSTRAP" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  validate_installation_bootstrap
}

advance_installation_bootstrap() {
  local expected="$1" next="$2" current tmp
  operation_assert_active || return 1; require_deployment_lock || return 1
  validate_installation_bootstrap || return 1
  current="$(/usr/bin/jq -r .phase "$ZEDBOT_INSTALLATION_BOOTSTRAP")"
  [ "$current" = "$expected" ] || return 1
  case "$expected:$next" in initialized:canonical-published|canonical-published:health-confirmed|health-confirmed:promoted) ;; *) return 1;; esac
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.bootstrap-phase.XXXXXXXX")" || return 1
  /usr/bin/jq --arg phase "$next" '.phase=$phase' "$ZEDBOT_INSTALLATION_BOOTSTRAP" > "$tmp" && atomic_write_metadata "$tmp" "$ZEDBOT_INSTALLATION_BOOTSTRAP"
  local rc=$?; rm -f "$tmp"; [ "$rc" -eq 0 ] && validate_installation_bootstrap && [ "$(/usr/bin/jq -r .phase "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = "$next" ]
}

convert_supported_legacy_installation() {
  local before after
  operation_assert_active || return 1; require_deployment_lock || return 1
  [ ! -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] && [ ! -L "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] || return 1
  validate_supported_legacy_installation || return 1
  before="$(/usr/bin/sha256sum "$ZEDBOT_LEGACY_INSTALLATION" | /usr/bin/awk '{print $1}')" || return 1
  write_lifecycle_role "$ZEDBOT_LEGACY_INSTALLATION" current "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
  after="$(/usr/bin/sha256sum "$ZEDBOT_LEGACY_INSTALLATION" | /usr/bin/awk '{print $1}')" || return 1
  [ "$before" = "$after" ] || { log_error "Legacy evidence changed during conversion."; return 1; }
  validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current &&
    validate_generation_owned_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" &&
    advance_installation_bootstrap initialized canonical-published &&
    advance_installation_bootstrap canonical-published health-confirmed &&
    advance_installation_bootstrap health-confirmed promoted
}

publish_first_install_current() {
  local candidate="$1"
  operation_assert_active || return 1; require_deployment_lock || return 1
  validate_installation_bootstrap || return 1
  [ "$(/usr/bin/jq -r '.kind+":"+.phase' "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = first-install:health-confirmed ] || return 1
  [ ! -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] && [ ! -e "$ZEDBOT_ROLLBACK_METADATA" ] || return 1
  validate_generation_metadata_core "$candidate" candidate || return 1
  [ "$(/usr/bin/jq -r '.state+":"+(.healthConfirmed|tostring)' "$candidate")" = healthy-candidate:true ] || return 1
  write_lifecycle_role "$candidate" current "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
  validate_generation_owned_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
  remove_canonical_state_file "$candidate" || return 1
  advance_installation_bootstrap health-confirmed promoted
}

remove_canonical_state_file() {
  local file="$1" before
  require_deployment_lock || return 1
  validate_state_regular_file "$file" || return 1
  before="$(stat -c %d:%i "$file")" || return 1
  [ "$before" = "$(stat -c %d:%i "$file")" ] || return 1
  rm -f -- "$file"
}

# operation-state.json is a live in-flight marker, not a permanent record:
# current_readiness_attempt() and initialize_operation_state() already treat
# its absence as "no operation is currently running", and rollback-status
# treats its mere PRESENCE - regardless of stage - as an incomplete
# operation. Leaving it on disk with stage "promoted" forever after every
# operation that has ever completed would permanently and silently block
# rollback-status starting with the very first successful install/update/
# rollback. Best-effort: an already-successful operation must not be
# reported as failed over this bookkeeping step.
finalize_promoted_operation_state() {
  validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 0
  [ "$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE" 2>/dev/null)" = promoted ] || return 0
  remove_canonical_state_file "$ZEDBOT_OPERATION_STATE" || log_warn "Could not clear the completed operation-state marker; rerun 'zedbot doctor' if rollback-status later reports an incomplete operation."
  return 0
}

# update and rollback are mutually exclusive. An unlocked, valid persistent
# lock inode is the only accepted stale-lock state; it is safe to reacquire.
acquire_deployment_lock() {
  local create_tmp="" canonical_id fd_id
  secure_deployment_dir || return 1
  validate_canonical_state_destination "$ZEDBOT_DEPLOYMENT_LOCK" || return 1
  [ "$ZEDBOT_DEPLOYMENT_LOCK_HELD" -eq 0 ] || { log_error "This process already owns the deployment lock."; return 1; }
  create_tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.lock-create.XXXXXXXX")" || return 1
  chmod 600 "$create_tmp" || { rm -f -- "$create_tmp"; return 1; }
  exec 9<>"$create_tmp" || { rm -f -- "$create_tmp"; return 1; }
  if ln -- "$create_tmp" "$ZEDBOT_DEPLOYMENT_LOCK" 2>/dev/null; then
    rm -f -- "$create_tmp"
  else
    exec 9>&-
    rm -f -- "$create_tmp"
    validate_state_regular_file "$ZEDBOT_DEPLOYMENT_LOCK" || return 1
    exec 9<>"$ZEDBOT_DEPLOYMENT_LOCK" || return 1
  fi
  canonical_id="$(stat -c %d:%i "$ZEDBOT_DEPLOYMENT_LOCK" 2>/dev/null || true)"
  fd_id="$(stat -Lc %d:%i /proc/$$/fd/9 2>/dev/null || true)"
  [ -n "$canonical_id" ] && [ "$canonical_id" = "$fd_id" ] && [ -f /proc/$$/fd/9 ] &&
    [ "$(stat -Lc %u:%a /proc/$$/fd/9)" = "0:600" ] || {
      log_error "Deployment lock was substituted or has unsafe attributes."; exec 9>&-; return 1;
    }
  if ! flock -n 9; then
    log_error "Another update or rollback is already running and owns the deployment lock."
    exec 9>&-
    return 1
  fi
  ZEDBOT_DEPLOYMENT_LOCK_ID="$fd_id"
  ZEDBOT_DEPLOYMENT_LOCK_HELD=1
}

release_deployment_lock() {
  local canonical_id fd_id
  [ "$ZEDBOT_DEPLOYMENT_LOCK_HELD" -eq 1 ] && [ -n "$ZEDBOT_DEPLOYMENT_LOCK_ID" ] || { log_error "This process does not own the deployment lock."; return 1; }
  canonical_id="$(stat -c %d:%i "$ZEDBOT_DEPLOYMENT_LOCK" 2>/dev/null || true)"
  fd_id="$(stat -Lc %d:%i /proc/$$/fd/9 2>/dev/null || true)"
  [ "$canonical_id" = "$ZEDBOT_DEPLOYMENT_LOCK_ID" ] && [ "$fd_id" = "$ZEDBOT_DEPLOYMENT_LOCK_ID" ] || {
    log_error "Deployment lock ownership cannot be proven; refusing cleanup."; return 1;
  }
  flock -u 9 || return 1
  exec 9>&-
  ZEDBOT_DEPLOYMENT_LOCK_HELD=0
  ZEDBOT_DEPLOYMENT_LOCK_ID=""
}

deployment_lock_is_owned() {
  [ "$ZEDBOT_DEPLOYMENT_LOCK_HELD" -eq 1 ] && [ -n "$ZEDBOT_DEPLOYMENT_LOCK_ID" ] &&
    [ "$(stat -c %d:%i "$ZEDBOT_DEPLOYMENT_LOCK" 2>/dev/null || true)" = "$ZEDBOT_DEPLOYMENT_LOCK_ID" ] &&
    [ "$(stat -Lc %d:%i /proc/$$/fd/9 2>/dev/null || true)" = "$ZEDBOT_DEPLOYMENT_LOCK_ID" ]
}

require_deployment_lock() {
  deployment_lock_is_owned || { log_error "Deployment state mutation requires the owned canonical lock."; return 1; }
}

secure_deployment_dir() {
  local parent
  validate_deployment_path_contract || return 1
  parent="${ZEDBOT_DEPLOYMENT_DIR%/*}"
  [ -d "$parent" ] && [ ! -L "$parent" ] || { log_error "Deployment-state parent is missing or symlinked."; return 1; }
  if [ -e "$ZEDBOT_DEPLOYMENT_DIR" ] || [ -L "$ZEDBOT_DEPLOYMENT_DIR" ]; then
    [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ] && [ -d "$ZEDBOT_DEPLOYMENT_DIR" ] || { log_error "Deployment-state directory must not be a symlink."; return 1; }
  else
    mkdir -m 700 -- "$ZEDBOT_DEPLOYMENT_DIR" || return 1
  fi
  [ "$(stat -c %u:%a "$ZEDBOT_DEPLOYMENT_DIR")" = "0:700" ] || { log_error "Deployment-state directory must be root-owned with mode 700."; return 1; }
}

publish_validated_legacy_self_heal() {
  local sha="$1" tree="$2" snapshot="$3" generation operation image_id evidence compose_sha tmp baseline migration_json
  require_deployment_lock || return 1
  [ "$(classify_installation first-install)" = genuine-first-install ] || return 1
  require_source_integrity "$sha" "$tree" "$snapshot" || return 1
  set_update_compose_contract "$snapshot" "$sha" "$tree" || return 1
  validate_compose_application_images || return 1
  validate_migration_declaration_pair "$snapshot" || return 1
  image_id="$(run_clean_docker image inspect -f '{{.Id}}' "$ZEDBOT_EXPECTED_APPLICATION_IMAGE")" || return 1
  valid_image_id "$image_id" || return 1
  verify_application_recreation_set "$image_id" || return 1
  generation="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
  operation="$(< /proc/sys/kernel/random/uuid)"
  initialize_operation_state install "$generation" || return 1
  validate_dependencies_healthy || return 1
  advance_operation_state bootstrap-initialized dependency-ready || return 1
  require_source_integrity "$sha" "$tree" "$snapshot" || return 1
  retain_known_good_image "$image_id" "zedbot-app:rollback-${generation}" || return 1
  retain_known_good_image "$image_id" "zedbot-app:generation-${generation}" || return 1
  advance_operation_state dependency-ready candidate-image-built || return 1
  baseline="$(find "$snapshot/packages/database/prisma/migrations" -mindepth 2 -maxdepth 2 -name migration.sql -printf '%h\n' | sed 's#.*/##' | sort | paste -sd, -)"
  [ -n "$baseline" ] || return 1
  migration_json="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/migration-status.js | tail -n 1)" || return 1
  [ "$(printf '%s' "$migration_json" | /usr/bin/jq -r '.ok == true and .upToDate == true and .failedCount == 0')" = true ] || return 1
  evidence="$ZEDBOT_DEPLOYMENT_DIR/evidence-${generation}"
  persist_migration_declaration_evidence "$snapshot" "$evidence" || return 1
  compose_sha="$(sha256sum "$evidence/docker-compose.yml" | awk '{print $1}')" || return 1
  advance_operation_state candidate-image-built migrations-confirmed || return 1
  record_bot_recreation_boundary "$image_id" "$sha" || return 1
  advance_operation_state migrations-confirmed application-recreated || return 1
  validate_running_application "$sha" >/dev/null || return 1
  advance_operation_state application-recreated health-confirmed || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.legacy-current.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg generation "$generation" --arg tree "$tree" --arg sha "$sha" --arg image "$image_id" \
    --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg baseline "$baseline" --arg evidence "$evidence" \
    --arg composeSha "$compose_sha" --arg manifestSha "$MIGRATION_MANIFEST_SHA256" --argjson declarations "$MIGRATION_DECLARATIONS_JSON" \
    '{formatVersion:2,installationKind:null,lifecycleRole:"current",generation:$generation,sourceTree:$tree,
      preDeploySha:$sha,preDeployImageId:$image,targetDeploySha:$sha,targetImageId:$image,
      retainedImageTag:("zedbot-app:rollback-"+$generation),immutableImageTag:("zedbot-app:generation-"+$generation),
      failedTargetTag:("zedbot-app:failed-"+$generation),capturedAt:$capturedAt,preDeployMigrations:($baseline|split(",")),
      declarationFormatVersion:2,declarationSourceCategory:"generation-evidence",migrationEvidencePath:$evidence,
      composeEvidencePath:($evidence+"/docker-compose.yml"),composeEvidenceSha256:$composeSha,composeProjectName:"zedbot",
      composeApplicationImage:"zedbot-app:latest",compatibilityManifestSha256:$manifestSha,compatibilityDeclarations:$declarations,
      recreationAttempted:true,healthConfirmed:true,state:"known-good"}' > "$tmp" || return 1
  atomic_write_metadata "$tmp" "$ZEDBOT_LEGACY_INSTALLATION" || return 1
  rm -f "$tmp"
  validate_supported_legacy_installation || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.bootstrap.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg generation "$generation" --arg operation "$operation" --arg sourceSha "$sha" --arg sourceTree "$tree" \
    '{formatVersion:1,kind:"legacy-upgrade",generation:$generation,operation:$operation,phase:"initialized",sourceSha:$sourceSha,sourceTree:$sourceTree}' > "$tmp" || return 1
  atomic_write_metadata "$tmp" "$ZEDBOT_INSTALLATION_BOOTSTRAP" || return 1
  rm -f "$tmp"
  validate_installation_bootstrap || return 1
  convert_supported_legacy_installation || return 1
  advance_operation_state health-confirmed promotion-prepared || return 1
  advance_operation_state promotion-prepared promoted || return 1
  finalize_promoted_operation_state
  [ ! -e "$ZEDBOT_ROLLBACK_METADATA" ] && [ "$(classify_installation observe)" = existing-canonical ]
}

valid_git_sha() { printf '%s' "${1:-}" | grep -Eq '^[a-f0-9]{40}$'; }
valid_image_id() { printf '%s' "${1:-}" | grep -Eq '^sha256:[a-f0-9]{64}$'; }

MIGRATION_DECLARATIONS_JSON=""
MIGRATION_MANIFEST_SHA256=""
validate_migration_declaration_pair() {
  local root="$1" prisma manifest migrations entry name expected actual
  local -a declared_names=() actual_names=() children=()
  root="$(realpath -e -- "$root" 2>/dev/null)" || { log_error "Migration declaration root is unavailable."; return 1; }
  prisma="$root/packages/database/prisma"
  manifest="$prisma/rollback-compatibility.json"
  migrations="$prisma/migrations"
  [ "$(realpath -e -- "$prisma" 2>/dev/null)" = "$prisma" ] || { log_error "Migration declaration pair escapes its trusted root."; return 1; }
  [ -f "$manifest" ] && [ ! -L "$manifest" ] || { log_error "Migration manifest is unavailable or not a regular file."; return 1; }
  [ -d "$migrations" ] && [ ! -L "$migrations" ] || { log_error "Migrations directory is unavailable or symlinked."; return 1; }
  jq -e '
    type == "object" and keys == ["backwardCompatibleMigrations","formatVersion"] and
    .formatVersion == 2 and
    (.backwardCompatibleMigrations|type == "array") and
    all(.backwardCompatibleMigrations[];
      type == "object" and keys == ["name","sqlSha256"] and
      (.name|type == "string" and test("^[0-9]{14}_[a-z0-9_]+$")) and
      (.sqlSha256|type == "string" and test("^[a-f0-9]{64}$"))) and
    ((.backwardCompatibleMigrations|map(.name)|length) ==
     (.backwardCompatibleMigrations|map(.name)|unique|length))
  ' "$manifest" >/dev/null 2>&1 || { log_error "Migration manifest JSON or format-2 schema is invalid."; return 1; }
  mapfile -t declared_names < <(jq -r '.backwardCompatibleMigrations|sort_by(.name)|.[].name' "$manifest")
  shopt -s nullglob dotglob
  for entry in "$migrations"/*; do
    if [ "${entry##*/}" = migration_lock.toml ] && [ -f "$entry" ] && [ ! -L "$entry" ]; then
      continue
    fi
    [ -d "$entry" ] && [ ! -L "$entry" ] || { shopt -u nullglob dotglob; log_error "Unexpected non-directory entry in migrations directory: ${entry##*/}"; return 1; }
    name="${entry##*/}"
    printf '%s' "$name" | grep -Eq '^[0-9]{14}_[a-z0-9_]+$' || { shopt -u nullglob dotglob; log_error "Invalid migration directory name: $name"; return 1; }
    actual_names+=("$name")
    children=("$entry"/*)
    [ "${#children[@]}" -eq 1 ] && [ "${children[0]##*/}" = migration.sql ] && [ -f "${children[0]}" ] && [ ! -L "${children[0]}" ] || {
      shopt -u nullglob dotglob; log_error "Migration directory must contain exactly one regular migration.sql: $name"; return 1;
    }
  done
  shopt -u nullglob dotglob
  mapfile -t actual_names < <(printf '%s\n' "${actual_names[@]}" | LC_ALL=C sort)
  [ "$(printf '%s\n' "${declared_names[@]}")" = "$(printf '%s\n' "${actual_names[@]}")" ] || {
    log_error "Declared migration set does not exactly match migration directories."; return 1;
  }
  while IFS=$'\t' read -r name expected; do
    actual="$(sha256sum "$migrations/$name/migration.sql" 2>/dev/null | awk '{print $1}')" || {
      log_error "Cannot hash exact migration SQL bytes: $name"; return 1;
    }
    [ "$actual" = "$expected" ] || { log_error "Migration SQL checksum mismatch: $name"; return 1; }
  done < <(jq -r '.backwardCompatibleMigrations|sort_by(.name)|.[]|[.name,.sqlSha256]|@tsv' "$manifest")
  MIGRATION_DECLARATIONS_JSON="$(jq -cS '.backwardCompatibleMigrations|sort_by(.name)' "$manifest")" || return 1
  MIGRATION_MANIFEST_SHA256="$(sha256sum "$manifest" | awk '{print $1}')" || return 1
}

persist_migration_declaration_evidence() (
  local source_root="$1" destination="$2" parent tmp source_json source_sha
  _cleanup_evidence_tmp() {
    case "${tmp:-}" in "$ZEDBOT_DEPLOYMENT_DIR"/.evidence.*) chmod -R u+w "$tmp" 2>/dev/null || true; find -P "$tmp" -depth -delete 2>/dev/null || true;; esac
  }
  secure_deployment_dir || return 1
  require_deployment_lock || return 1
  parent="$(dirname "$destination")"
  [ "$parent" = "$ZEDBOT_DEPLOYMENT_DIR" ] || { log_error "Migration evidence destination is not generation-scoped."; return 1; }
  printf '%s' "${destination##*/}" | grep -Eq '^evidence-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$' || { log_error "Migration evidence destination has an invalid generation identity."; return 1; }
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || { log_error "Migration evidence generation already exists."; return 1; }
  validate_migration_declaration_pair "$source_root" || return 1
  source_json="$MIGRATION_DECLARATIONS_JSON"; source_sha="$MIGRATION_MANIFEST_SHA256"
  tmp="$(operation_mktemp_dir "$ZEDBOT_DEPLOYMENT_DIR/.evidence.XXXXXXXX")" || return 1
  trap _cleanup_evidence_tmp EXIT
  trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
  mkdir -p "$tmp/packages/database/prisma"
  cp -a -- "$source_root/packages/database/prisma/rollback-compatibility.json" "$tmp/packages/database/prisma/"
  cp -a -- "$source_root/packages/database/prisma/migrations" "$tmp/packages/database/prisma/"
  cp -a -- "$source_root/docker-compose.yml" "$tmp/docker-compose.yml"
  validate_migration_declaration_pair "$tmp" || return 1
  [ "$MIGRATION_DECLARATIONS_JSON" = "$source_json" ] && [ "$MIGRATION_MANIFEST_SHA256" = "$source_sha" ] || {
    log_error "Persisted migration evidence differs from immutable source."; return 1;
  }
  chmod -R a-w "$tmp"
  sync -f "$tmp" || return 1
  mv -T -- "$tmp" "$destination"
  sync -f "$ZEDBOT_DEPLOYMENT_DIR" || return 1
  trap - EXIT INT TERM HUP
)

application_container_sha() {
  local service="$1"
  run_compose exec -T "$service" sh -c 'printf "%s" "${GIT_SHA:-}"' 2>/dev/null | tr -d '[:space:]'
}

application_container_image_id() {
  local service="$1" cid
  cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || return 1
  run_clean_docker inspect -f '{{.Image}}' "$cid" 2>/dev/null
}

# Reads the worker heartbeat through the worker's own Redis configuration. It
# neither writes Redis nor addresses the redis/postgres Compose services.
# Diagnostics are a fixed, non-secret reason code plus (only for staleness)
# the observed age in milliseconds - never the connection options, the
# heartbeat value itself, or any error detail that could carry a credential.
check_fresh_worker_heartbeat() {
  # A cold `docker compose exec` plus fresh Node ESM module resolution for
  # bullmq's dependency graph, repeated on every readiness poll, was
  # empirically SIGKILLed by an earlier version of this probe's own internal
  # timeout on EVERY attempt for a whole 90s readiness budget in real CI -
  # confirmed by zero diagnostic output (not even the probe's own error
  # branches ever got a chance to print). Query Redis directly instead: the
  # key (packages/shared/src/ops.ts WORKER_HEARTBEAT_KEY) already carries its
  # own TTL (EX WORKER_HEARTBEAT_TTL_SECONDS, refreshed on every worker
  # heartbeat tick), so a present, non-nil value already IS a fresh one -
  # Redis deletes it itself once the worker stops ticking, no manual age
  # comparison needed. redis-cli is the redis image's own tiny static
  # binary (no cold ESM module resolution) and reads REDISCLI_AUTH from its
  # own container env for auth, same as doctor.sh's own `redis-cli ping`
  # health probe and legacy-upgrade-test.sh's independent heartbeat
  # assertion (both already proven to work in this exact CI environment).
  local value
  value="$(run_compose exec -T redis timeout -s KILL 8 redis-cli GET zedbot:worker:heartbeat 2>/dev/null | tr -d '[:space:]')" || return 1
  [ -n "$value" ] && [ "$value" != "(nil)" ]
}

validate_running_application() {
  local expected_sha="${1:-}" expected_image_id attempt
  if [ -z "$expected_sha" ]; then
    validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
    expected_sha="$(/usr/bin/jq -r '.targetDeploySha' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")"
  fi
  valid_git_sha "$expected_sha" || { log_error "Application readiness requires the expected full deployment SHA."; return 1; }
  require_deployment_lock || return 1
  attempt="$(current_readiness_attempt)" || { log_error "Application readiness requires a valid locked operation state."; return 1; }
  expected_image_id="$(run_clean_docker image inspect -f '{{.Id}}' "$ZEDBOT_EXPECTED_APPLICATION_IMAGE")" || {
    log_error "Application readiness cannot resolve the immutable deployment image identity."; return 1;
  }
  valid_image_id "$expected_image_id" || return 1
  wait_for_readiness_policy application "$attempt" "$expected_image_id" "$expected_sha" 90 3 || return 1
  wait_for_real_bot_readiness "$attempt" "$expected_image_id" "$expected_sha" 90 3 || return 1
  printf '%s %s\n' "$expected_sha" "$expected_image_id"
}

# shellcheck disable=SC2120  # every call site uses the canonical default;
# the override parameter follows this file's validate_* convention and is
# immediately pinned back to the one true canonical path below.
validate_bot_recreation_boundary() {
  local file="${1:-$ZEDBOT_BOT_RECREATION_BOUNDARY}"
  [ "$file" = "$ZEDBOT_BOT_RECREATION_BOUNDARY" ] || return 1
  validate_state_regular_file "$file" || return 1
  /usr/bin/jq -e '
    type=="object" and keys==["containerId","formatVersion","generation","imageId","imageRef","operation","project","recreatedAt","service"] and
    .formatVersion==1 and (.operation|type=="string" and test("^(install|update|rollback):[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    (.generation|type=="string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    (.containerId|type=="string" and length>0) and (.imageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and
    .imageRef=="zedbot-app:latest" and .project=="zedbot" and .service=="bot" and
    (.recreatedAt|type=="number" and .>=0)
  ' "$file" >/dev/null 2>&1
}

record_bot_recreation_boundary() {
  local expected_image_id="$1" expected_sha="$2" kind generation stage operation ids cid inspection actual_image actual_generation tmp
  require_deployment_lock || return 1
  validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 1
  kind="$(/usr/bin/jq -r '.kind' "$ZEDBOT_OPERATION_STATE")"; generation="$(/usr/bin/jq -r '.generation' "$ZEDBOT_OPERATION_STATE")"; stage="$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")"
  case "$kind:$stage" in install:migrations-confirmed|update:migrations-confirmed|rollback:compatibility-confirmed) ;; *) log_error "Bot recreation boundary has an invalid operation predecessor."; return 1;; esac
  operation="$kind:$generation"
  ids="$(run_compose ps --all -q bot)" || return 1
  [ "$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d' | /usr/bin/wc -l)" -eq 1 ] || return 1
  cid="$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d')"
  inspection="$(run_clean_docker inspect "$cid")" || return 1
  printf '%s' "$inspection" | /usr/bin/jq -e --arg cid "$cid" '
    type=="array" and length==1 and .[0].Id==$cid and .[0].Config.Image=="zedbot-app:latest" and
    .[0].Config.Labels["com.docker.compose.project"]=="zedbot" and .[0].Config.Labels["com.docker.compose.service"]=="bot"
  ' >/dev/null 2>&1 || return 1
  actual_image="$(printf '%s' "$inspection" | /usr/bin/jq -r '.[0].Image')"
  actual_generation="$(printf '%s' "$inspection" | /usr/bin/jq -r '[.[0].Config.Env[]? | select(startswith("GIT_SHA=")) | ltrimstr("GIT_SHA=")] | if length==1 then .[0] else "" end')"
  [ "$actual_image" = "$expected_image_id" ] || return 1
  [ "$actual_generation" = "$expected_sha" ] || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.bot-boundary.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg operation "$operation" --arg generation "$generation" --arg cid "$cid" --arg image "$actual_image" --argjson at "$(readiness_now)" \
    '{formatVersion:1,operation:$operation,generation:$generation,containerId:$cid,imageId:$image,imageRef:"zedbot-app:latest",project:"zedbot",service:"bot",recreatedAt:$at}' > "$tmp" || { rm -f "$tmp"; return 1; }
  atomic_write_metadata "$tmp" "$ZEDBOT_BOT_RECREATION_BOUNDARY" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  validate_bot_recreation_boundary
}

collect_real_bot_readiness_evidence() {
  local attempt="$1" observed="$2" expected_sha="$3" operation ids cid inspection marker marker_rc
  validate_bot_recreation_boundary || return 1
  operation="${attempt%:*}"
  [ "$(/usr/bin/jq -r '.operation' "$ZEDBOT_BOT_RECREATION_BOUNDARY")" = "$operation" ] || return 1
  ids="$(run_compose ps --all -q bot)" || return 1
  [ "$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d' | /usr/bin/wc -l)" -eq 1 ] || return 1
  cid="$(printf '%s\n' "$ids" | /usr/bin/sed '/^$/d')"
  [ "$cid" = "$(/usr/bin/jq -r '.containerId' "$ZEDBOT_BOT_RECREATION_BOUNDARY")" ] || return 1
  inspection="$(run_clean_docker inspect "$cid")" || return 1
  printf '%s' "$inspection" | /usr/bin/jq -e 'type=="array" and length==1 and (.[0]|type=="object")' >/dev/null 2>&1 || return 1
  if marker="$(run_compose exec -T bot node apps/bot/dist/cli/readiness.js)"; then marker_rc=0; else marker_rc=$?; fi
  case "$marker_rc" in 0|3) ;; *) return 1;; esac
  printf '%s' "$marker" | /usr/bin/jq -e . >/dev/null 2>&1 || return 1
  printf '%s' "$inspection" | /usr/bin/jq -c --arg attempt "$attempt" --argjson observed "$observed" --argjson marker "$marker" --slurpfile boundary "$ZEDBOT_BOT_RECREATION_BOUNDARY" '
    {formatVersion:1,kind:"real-bot",attempt:$attempt,observedAt:$observed,boundary:$boundary[0],bot:{
      service:(.[0].Config.Labels["com.docker.compose.service"] // ""),project:(.[0].Config.Labels["com.docker.compose.project"] // ""),
      containerId:.[0].Id,imageId:.[0].Image,imageRef:.[0].Config.Image,status:.[0].State.Status,restartCount:.[0].RestartCount,
      generation:([.[0].Config.Env[]? | select(startswith("GIT_SHA=")) | ltrimstr("GIT_SHA=")] | if length==1 then .[0] else "" end),marker:$marker}}
  '
}

# Returns 0 ready, 1 retryable startup, or 2 terminal/invalid.
evaluate_real_bot_readiness_evidence() {
  local evidence="$1" attempt="$2" started="$3" now="$4" expected_image="$5" expected_sha="$6" operation
  operation="${attempt%:*}"
  printf '%s' "$evidence" | /usr/bin/jq -e --arg attempt "$attempt" --arg operation "$operation" --argjson started "$started" --argjson now "$now" --arg image "$expected_image" --arg sha "$expected_sha" '
    . as $root | type=="object" and keys==["attempt","bot","boundary","formatVersion","kind","observedAt"] and .formatVersion==1 and .kind=="real-bot" and
    .attempt==$attempt and (.observedAt|type=="number") and .observedAt >= $started and .observedAt <= $now and ($now-.observedAt)<=5 and
    (.boundary|type=="object" and keys==["containerId","formatVersion","generation","imageId","imageRef","operation","project","recreatedAt","service"] and
      .formatVersion==1 and .operation==$operation and .imageId==$image and .imageRef=="zedbot-app:latest" and .project=="zedbot" and .service=="bot") and
    (.bot|type=="object" and keys==["containerId","generation","imageId","imageRef","marker","project","restartCount","service","status"] and
      .service=="bot" and .project=="zedbot" and .containerId==$root.boundary.containerId and .imageId==$image and .imageId==$root.boundary.imageId and
      .imageRef=="zedbot-app:latest" and .generation==$sha and (.restartCount|type=="number" and .==0) and (.status|type=="string"))
  ' >/dev/null 2>&1 || return 2
  if printf '%s' "$evidence" | /usr/bin/jq -e --arg sha "$expected_sha" --argjson now "$now" '
    .bot.status=="running" and (.bot.marker|type=="object") and
    (.bot.marker|keys==["components","formatVersion","generation","processId","processInstanceId","processStartTicks","processStartedAt","readyAt","state"]) and
    .bot.marker.formatVersion==1 and .bot.marker.state=="ready" and .bot.marker.generation==$sha and
    (.bot.marker.processId|type=="number" and .>=1) and (.bot.marker.processInstanceId|type=="string" and test("^[a-f0-9-]{36}$")) and (.bot.marker.processStartTicks|type=="string" and test("^[0-9]+$")) and
    (.bot.marker.processStartedAt|type=="number") and (.bot.marker.readyAt|type=="number") and .bot.marker.processStartedAt<=.bot.marker.readyAt and .bot.marker.readyAt<=($now*1000+5000) and
    (.bot.marker.components=={application:true,handlers:true,localLoops:true,shutdownHandlers:true})
  ' >/dev/null; then return 0; fi
  if printf '%s' "$evidence" | /usr/bin/jq -e '.bot.status=="running" and .bot.restartCount==0 and .bot.marker=={formatVersion:1,state:"starting"}' >/dev/null; then return 1; fi
  return 2
}

wait_for_real_bot_readiness() {
  local attempt="$1" expected_image="$2" expected_sha="$3" timeout="${4:-90}" interval="${5:-3}" started now evidence rc previous_identity="" identity
  [[ "$timeout" =~ ^[1-9][0-9]*$ && "$interval" =~ ^[1-9][0-9]*$ ]] || return 1
  require_deployment_lock || return 1
  started="$(readiness_now)" || return 1
  while :; do
    operation_assert_active || return 1
    now="$(readiness_now)" || return 1
    [ "$now" -le $((started + timeout)) ] || { log_error "Real Bot readiness timed out."; return 1; }
    evidence="$(collect_real_bot_readiness_evidence "$attempt" "$now" "$expected_sha")" || { log_error "Real Bot readiness inspection failed."; return 1; }
    identity="$(printf '%s' "$evidence" | /usr/bin/jq -er '.bot.containerId+":"+.bot.imageId')" || return 1
    [ -z "$previous_identity" ] || [ "$identity" = "$previous_identity" ] || { log_error "Real Bot identity changed during readiness polling."; return 1; }
    previous_identity="$identity"
    if evaluate_real_bot_readiness_evidence "$evidence" "$attempt" "$started" "$now" "$expected_image" "$expected_sha"; then rc=0; else rc=$?; fi
    case "$rc" in 0) return 0;; 2) log_error "Real Bot readiness is terminal, malformed, stale, incomplete, or identity-mismatched."; return 1;; esac
    [ $((now + interval)) -le $((started + timeout)) ] || { log_error "Real Bot readiness timed out."; return 1; }
    readiness_pause "$interval" || { log_error "Real Bot readiness was cancelled or interrupted."; return 1; }
  done
}

atomic_write_metadata() {
  local source="$1" destination="${2:-$ZEDBOT_ROLLBACK_METADATA}" tmp
  operation_assert_active || return 1
  secure_deployment_dir || return 1
  require_deployment_lock || return 1
  validate_canonical_state_destination "$destination" || return 1
  [ -f "$source" ] && [ ! -L "$source" ] || { log_error "Metadata source must be a regular non-symlink file."; return 1; }
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    validate_state_regular_file "$destination" || return 1
  fi
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.metadata.XXXXXXXX")" || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  cp --no-preserve=mode,ownership "$source" "$tmp" && chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  sync -f "$tmp" || { rm -f "$tmp"; return 1; }
  [ ! -L "$destination" ] || { rm -f "$tmp"; return 1; }
  mv -T -- "$tmp" "$destination" || { rm -f "$tmp"; return 1; }
  sync -f "$ZEDBOT_DEPLOYMENT_DIR" || return 1
  validate_state_regular_file "$destination"
}

operation_stage_successor() {
  case "$1:$2" in
    install:bootstrap-initialized) echo dependency-ready ;;
    install:dependency-ready) echo candidate-image-built ;;
    install:candidate-image-built) echo migrations-confirmed ;;
    install:migrations-confirmed) echo application-recreated ;;
    install:application-recreated) echo health-confirmed ;;
    install:health-confirmed) echo promotion-prepared ;;
    install:promotion-prepared) echo promoted ;;
    update:current-validated) echo current-image-retained ;;
    update:current-image-retained) echo candidate-metadata-prepared ;;
    update:candidate-metadata-prepared) echo candidate-image-built ;;
    update:candidate-image-built) echo deployment-reference-tagged ;;
    update:deployment-reference-tagged) echo compatibility-confirmed ;;
    update:compatibility-confirmed) echo migrations-confirmed ;;
    update:migrations-confirmed) echo application-recreated ;;
    update:application-recreated) echo health-confirmed ;;
    update:health-confirmed) echo promotion-prepared ;;
    update:promotion-prepared) echo promoted ;;
    rollback:previous-selected) echo rollback-evidence-validated ;;
    rollback:rollback-evidence-validated) echo retained-image-validated ;;
    rollback:retained-image-validated) echo deployment-reference-retagged ;;
    rollback:deployment-reference-retagged) echo compatibility-confirmed ;;
    rollback:compatibility-confirmed) echo application-recreated ;;
    rollback:application-recreated) echo health-confirmed ;;
    rollback:health-confirmed) echo promotion-prepared ;;
    rollback:promotion-prepared) echo promoted ;;
    *) return 1 ;;
  esac
}
metadata_write_observer() { return 0; }

operation_stage_number() {
  case "$1:$2" in
    install:bootstrap-initialized) echo 1 ;;
    install:dependency-ready) echo 2 ;;
    install:candidate-image-built) echo 3 ;;
    install:migrations-confirmed) echo 4 ;;
    install:application-recreated) echo 5 ;;
    install:health-confirmed) echo 6 ;;
    install:promotion-prepared) echo 7 ;;
    install:promoted) echo 8 ;;
    update:current-validated | rollback:previous-selected) echo 1 ;;
    update:current-image-retained | rollback:rollback-evidence-validated) echo 2 ;;
    update:candidate-metadata-prepared | rollback:retained-image-validated) echo 3 ;;
    update:candidate-image-built | rollback:deployment-reference-retagged) echo 4 ;;
    update:deployment-reference-tagged | rollback:compatibility-confirmed) echo 5 ;;
    update:compatibility-confirmed | rollback:application-recreated) echo 6 ;;
    update:migrations-confirmed | rollback:health-confirmed) echo 7 ;;
    update:application-recreated | rollback:promotion-prepared) echo 8 ;;
    update:health-confirmed | rollback:promoted) echo 9 ;;
    update:promotion-prepared) echo 10 ;;
    update:promoted) echo 11 ;;
    *) return 1;; esac
}

validate_operation_state() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || { log_error "Operation state is unavailable or symlinked."; return 1; }
  if [ "$file" = "$ZEDBOT_OPERATION_STATE" ]; then
    validate_state_regular_file "$file" || return 1
  else
    [ "${file%/*}" = "$ZEDBOT_DEPLOYMENT_DIR" ] && [ "$(stat -c %u:%a "$file")" = "0:600" ] || {
      log_error "Temporary operation state is outside the trusted directory or has unsafe attributes."; return 1;
    }
  fi
  /usr/bin/jq -e '
    type=="object" and keys==["formatVersion","generation","kind","stage"] and .formatVersion==1 and
    (.generation|type=="string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    ((.kind=="install" and (.stage|IN("bootstrap-initialized","dependency-ready","candidate-image-built","migrations-confirmed","application-recreated","health-confirmed","promotion-prepared","promoted"))) or
     (.kind=="update" and (.stage|IN("current-validated","current-image-retained","candidate-metadata-prepared","candidate-image-built","deployment-reference-tagged","compatibility-confirmed","migrations-confirmed","application-recreated","health-confirmed","promotion-prepared","promoted"))) or
     (.kind=="rollback" and (.stage|IN("previous-selected","rollback-evidence-validated","retained-image-validated","compatibility-confirmed","deployment-reference-retagged","application-recreated","health-confirmed","promotion-prepared","promoted"))))
  ' "$file" >/dev/null 2>&1 || { log_error "Operation state schema or stage is invalid."; return 1; }
}

initialize_operation_state() {
  local kind="$1" generation="$2" first tmp
  case "$kind" in install) first="bootstrap-initialized" ;; update) first="current-validated" ;; rollback) first="previous-selected" ;; *) return 1;; esac
  if [ -e "$ZEDBOT_OPERATION_STATE" ] || [ -L "$ZEDBOT_OPERATION_STATE" ]; then
    validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 1
    if [ "$(/usr/bin/jq -r '.kind+":"+.generation' "$ZEDBOT_OPERATION_STATE")" = "$kind:$generation" ]; then return 0; fi
    [ "$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")" = promoted ] || { log_error "Another incomplete deployment operation requires recovery."; return 1; }
  fi
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.operation-init.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg kind "$kind" --arg generation "$generation" --arg stage "$first" '{formatVersion:1,kind:$kind,generation:$generation,stage:$stage}' > "$tmp" && atomic_write_metadata "$tmp" "$ZEDBOT_OPERATION_STATE"
  local rc=$?; rm -f "$tmp"; [ "$rc" -eq 0 ] && validate_operation_state "$ZEDBOT_OPERATION_STATE"; return "$rc"
}

advance_operation_state() {
  local expected="$1" next="$2" kind current successor tmp
  operation_assert_active || return 1
  validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 1
  kind="$(/usr/bin/jq -r '.kind' "$ZEDBOT_OPERATION_STATE")"; current="$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")"
  [ "$current" = "$expected" ] || { log_error "Operation state predecessor mismatch: expected ${expected}, found ${current}."; return 1; }
  successor="$(operation_stage_successor "$kind" "$current")" || { log_error "Operation state has no allowed successor."; return 1; }
  [ "$successor" = "$next" ] || { log_error "Operation state transition ${current} -> ${next} is forbidden."; return 1; }
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.operation-stage.XXXXXXXX")" || return 1
  /usr/bin/jq --arg stage "$next" '.stage=$stage' "$ZEDBOT_OPERATION_STATE" > "$tmp" || { rm -f "$tmp"; return 1; }
  validate_operation_state "$tmp" || { rm -f "$tmp"; return 1; }
  metadata_write_observer "$tmp" "$ZEDBOT_OPERATION_STATE" || { rm -f "$tmp"; return 1; }
  atomic_write_metadata "$tmp" "$ZEDBOT_OPERATION_STATE" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  validate_operation_state "$ZEDBOT_OPERATION_STATE" && [ "$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")" = "$next" ]
}

confirm_operation_state() {
  local expected="$1" next="$2" kind current current_n expected_n next_n
  operation_assert_active || return 1
  validate_operation_state "$ZEDBOT_OPERATION_STATE" || return 1
  kind="$(/usr/bin/jq -r '.kind' "$ZEDBOT_OPERATION_STATE")"; current="$(/usr/bin/jq -r '.stage' "$ZEDBOT_OPERATION_STATE")"
  current_n="$(operation_stage_number "$kind" "$current")" || return 1
  expected_n="$(operation_stage_number "$kind" "$expected")" || return 1
  next_n="$(operation_stage_number "$kind" "$next")" || return 1
  [ "$next_n" -eq $((expected_n + 1)) ] || return 1
  if [ "$current_n" -eq "$expected_n" ]; then advance_operation_state "$expected" "$next"; return; fi
  [ "$current_n" -ge "$next_n" ] || { log_error "Operation state is behind the required predecessor."; return 1; }
}

run_confirmed_operation_step() {
  local expected="$1" next="$2" operation="$3" verification="$4"
  declare -F "$operation" >/dev/null && declare -F "$verification" >/dev/null || { log_error "Confirmed operation step requires declared functions."; return 1; }
  "$operation" || return 1
  "$verification" || return 1
  advance_operation_state "$expected" "$next"
}

verify_application_recreation_set() {
  local expected_image_id="$1" service cid image_id seen="" count=0
  valid_image_id "$expected_image_id" || return 1
  for service in api bot worker; do
    cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 2)" || return 1
    [ -n "$cid" ] && [ "$(printf '%s\n' "$cid" | wc -l)" -eq 1 ] || { log_error "Recreation confirmation for ${service} is missing or ambiguous."; return 1; }
    case " $seen " in *" $cid "*) log_error "Recreation returned a duplicated application container identity."; return 1;; esac
    seen="$seen $cid"
    image_id="$(run_clean_docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)" || return 1
    [ "$image_id" = "$expected_image_id" ] || { log_error "Recreated ${service} does not use the expected immutable image."; return 1; }
    count=$((count + 1))
  done
  [ "$count" -eq 3 ]
}

validate_generation_metadata_core() {
  local file="$1" role="${2:-}"
  validate_state_regular_file "$file" || { log_error "Generation metadata is unavailable or unsafe."; return 1; }
  /usr/bin/jq -e --arg role "$role" '
    ((keys - ["formatVersion","installationKind","lifecycleRole","generation","sourceTree","preDeploySha","preDeployImageId","targetDeploySha","targetImageId","retainedImageTag","immutableImageTag","failedTargetTag","capturedAt","preDeployMigrations","declarationFormatVersion","declarationSourceCategory","migrationEvidencePath","composeEvidencePath","composeEvidenceSha256","composeProjectName","composeApplicationImage","compatibilityManifestSha256","compatibilityDeclarations","recreationAttempted","healthConfirmed","state","rollbackTargetGeneration","rollbackTargetImageId"])|length==0) and
    .formatVersion == 2 and
    (.lifecycleRole|IN("candidate","current","previous","failed")) and
    ($role == "" or .lifecycleRole == $role) and
    (.generation|type=="string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    (.sourceTree|type=="string" and test("^[a-f0-9]{40}$")) and
    (.targetDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
    (if .installationKind == "first-install" then
       .preDeploySha == null and .preDeployImageId == null and .retainedImageTag == null and .preDeployMigrations == [] and
       (.lifecycleRole|IN("candidate","current"))
     else
       .installationKind == null and
       (.preDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
       (.preDeployImageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and
       (.retainedImageTag == ("zedbot-app:rollback-" + .generation))
     end) and
    (.capturedAt|type=="string") and
    (.preDeployMigrations|type=="array") and
    (.declarationFormatVersion==2) and (.declarationSourceCategory=="generation-evidence") and
    (.migrationEvidencePath|type=="string") and (.composeEvidencePath==(.migrationEvidencePath+"/docker-compose.yml")) and
    (.composeEvidenceSha256|type=="string" and test("^[a-f0-9]{64}$")) and
    (.composeProjectName=="zedbot") and (.composeApplicationImage=="zedbot-app:latest") and
    (.compatibilityManifestSha256|type=="string" and test("^[a-f0-9]{64}$")) and
    (.compatibilityDeclarations|type=="array") and
    ((.targetImageId == null) or (.targetImageId|type=="string" and test("^sha256:[a-f0-9]{64}$"))) and
    ((.failedTargetTag == null) or (.failedTargetTag == ("zedbot-app:failed-" + .generation))) and
    (.state|IN("prepared","application-recreated","healthy-candidate","known-good","failed-after-recreation","rollback-failed","rolled-back")) and
    (.recreationAttempted|type=="boolean") and
    (.healthConfirmed|type=="boolean") and
    (if .lifecycleRole == "candidate" then
     (.state|IN("prepared","application-recreated","healthy-candidate")) and
       (.healthConfirmed == (.state == "healthy-candidate")) and
       (if .state == "healthy-candidate" then .recreationAttempted == true and (.targetImageId|type=="string") and (.immutableImageTag|type=="string") and (.failedTargetTag|type=="string") else true end)
     elif (.lifecycleRole|IN("current","previous")) then
       .state == "known-good" and .healthConfirmed == true and .recreationAttempted == true and
       (.targetImageId|type=="string") and (.immutableImageTag|type=="string") and (.failedTargetTag|type=="string")
     else
       (.state|IN("failed-after-recreation","rollback-failed","rolled-back")) and
       .healthConfirmed == false and
       (.targetImageId|type=="string") and (.immutableImageTag|type=="string") and (.failedTargetTag|type=="string") and
       (.rollbackTargetGeneration|type=="string") and
       (.rollbackTargetImageId|type=="string" and test("^sha256:[a-f0-9]{64}$"))
     end)
  ' "$file" >/dev/null 2>&1 || { log_error "Generation metadata identity or transition state is invalid."; return 1; }
}

validate_generation_owned_evidence() {
  local file="$1" root recorded
  validate_generation_metadata_core "$file" || return 1
  root="$(/usr/bin/jq -er '.migrationEvidencePath' "$file")" || return 1
  [ "$root" = "$ZEDBOT_DEPLOYMENT_DIR/evidence-$(/usr/bin/jq -r '.generation' "$file")" ] || { log_error "Generation evidence path is not generation-owned."; return 1; }
  validate_migration_declaration_pair "$root" || return 1
  [ "$MIGRATION_MANIFEST_SHA256" = "$(/usr/bin/jq -r '.compatibilityManifestSha256' "$file")" ] || { log_error "Generation migration manifest evidence differs."; return 1; }
  recorded="$(/usr/bin/jq -cS '.compatibilityDeclarations|sort_by(.name)' "$file")" || return 1
  [ "$MIGRATION_DECLARATIONS_JSON" = "$recorded" ] || { log_error "Generation migration declarations differ."; return 1; }
  set_rollback_compose_contract "$root" "$(/usr/bin/jq -r '.composeEvidenceSha256' "$file")" || return 1
}

# --- Strictly read-only rollback eligibility (Area 11) ---------------------
# These helpers never create directories/files, acquire locks, install traps,
# invoke Docker/Compose, query a database, probe readiness, or recover state.
readonly ZEDBOT_ROLLBACK_STATUS_SCHEMA="zedbot.rollback-status/v1"
rollback_status_read_observer() { :; }
rollback_status_safe_file() {
  local file="$1" size before after
  validate_state_regular_file "$file" >/dev/null 2>&1 || return 1
  size="$(stat -Lc %s "$file" 2>/dev/null)" || return 1
  [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] || return 1
  before="$(stat -Lc '%d:%i:%s:%Y:%Z' "$file")" || return 1
  /usr/bin/jq -e . "$file" >/dev/null 2>&1 || return 1
  rollback_status_read_observer "$file" || return 1
  after="$(stat -Lc '%d:%i:%s:%Y:%Z' "$file")" || return 1
  [ "$before" = "$after" ]
}

# Validate generation-owned evidence without consulting or configuring the
# live Compose project/runtime environment. The mutating rollback path adds
# operational checks later, under its lock.
validate_generation_owned_evidence_readonly() {
  local file="$1" root generation compose recorded root_before root_after
  validate_generation_metadata_core "$file" || return 1
  generation="$(/usr/bin/jq -er '.generation' "$file")" || return 1
  root="$(/usr/bin/jq -er '.migrationEvidencePath' "$file")" || return 1
  [ "$root" = "$ZEDBOT_DEPLOYMENT_DIR/evidence-$generation" ] || return 1
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  root_before="$(stat -c '%d:%i:%Y:%Z' "$root" 2>/dev/null)" || return 1
  validate_migration_declaration_pair "$root" >/dev/null 2>&1 || return 1
  [ "$MIGRATION_MANIFEST_SHA256" = "$(/usr/bin/jq -r '.compatibilityManifestSha256' "$file")" ] || return 1
  recorded="$(/usr/bin/jq -cS '.compatibilityDeclarations|sort_by(.name)' "$file")" || return 1
  [ "$MIGRATION_DECLARATIONS_JSON" = "$recorded" ] || return 1
  compose="$root/docker-compose.yml"
  [ -f "$compose" ] && [ ! -L "$compose" ] || return 1
  [ "$(stat -c %s "$compose" 2>/dev/null)" -gt 0 ] && [ "$(stat -c %s "$compose" 2>/dev/null)" -le 1048576 ] || return 1
  [ "$(/usr/bin/sha256sum "$compose" | /usr/bin/awk '{print $1}')" = "$(/usr/bin/jq -r '.composeEvidenceSha256' "$file")" ] || return 1
  root_after="$(stat -c '%d:%i:%Y:%Z' "$root" 2>/dev/null)" || return 1
  [ "$root_before" = "$root_after" ]
}

validate_rollback_eligibility_evidence() {
  local current="${1:-$ZEDBOT_CURRENT_DEPLOYMENT_METADATA}" previous="${2:-$ZEDBOT_ROLLBACK_METADATA}" current_gen previous_gen
  rollback_status_safe_file "$current" || return 1
  rollback_status_safe_file "$previous" || return 1
  validate_generation_metadata_core "$current" current >/dev/null 2>&1 || return 1
  validate_generation_metadata_core "$previous" previous >/dev/null 2>&1 || return 1
  validate_generation_owned_evidence_readonly "$current" >/dev/null 2>&1 || return 1
  validate_generation_owned_evidence_readonly "$previous" >/dev/null 2>&1 || return 1
  current_gen="$(/usr/bin/jq -r .generation "$current")" || return 1
  previous_gen="$(/usr/bin/jq -r .generation "$previous")" || return 1
  [ "$current_gen" != "$previous_gen" ] || return 1
  [ "$(/usr/bin/jq -r '.preDeploySha' "$current")" = "$(/usr/bin/jq -r '.targetDeploySha' "$previous")" ] || return 1
  [ "$(/usr/bin/jq -r '.preDeployImageId' "$current")" = "$(/usr/bin/jq -r '.targetImageId' "$previous")" ] || return 1
  [ "$(/usr/bin/jq -r '.state+":"+(.healthConfirmed|tostring)' "$current")" = known-good:true ] || return 1
  [ "$(/usr/bin/jq -r '.state+":"+(.healthConfirmed|tostring)' "$previous")" = known-good:true ] || return 1
}

rollback_status_emit() {
  local status="$1" eligible="$2" reason="$3" message="$4" classification="$5" current_valid="$6" previous_present="$7" previous_valid="$8" source_valid="$9" image_valid="${10}" migration_valid="${11}" compose_valid="${12}" preconditions="${13}" current_gen="${14:-}" previous_gen="${15:-}" warning="${16:-}"
  /usr/bin/jq -cnS --arg schema "$ZEDBOT_ROLLBACK_STATUS_SCHEMA" --arg status "$status" --arg reasonCode "$reason" --arg reason "$message" \
    --arg classification "$classification" --arg currentGeneration "$current_gen" --arg previousGeneration "$previous_gen" --arg warning "$warning" \
    --argjson eligible "$eligible" --argjson currentValid "$current_valid" --argjson previousPresent "$previous_present" --argjson previousValid "$previous_valid" \
    --argjson sourceValid "$source_valid" --argjson imageValid "$image_valid" --argjson migrationValid "$migration_valid" --argjson composeValid "$compose_valid" --argjson preconditions "$preconditions" \
    '{schema:$schema,schemaVersion:1,installationClassification:$classification,rollbackStatus:$status,eligible:$eligible,reasonCode:$reasonCode,reason:$reason,
      currentGeneration:(if $currentGeneration=="" then null else $currentGeneration end),previousGeneration:(if $previousGeneration=="" then null else $previousGeneration end),
      evidence:{currentMetadataValid:$currentValid,previousMetadataPresent:$previousPresent,previousMetadataValid:$previousValid,immutableSourceEvidenceValid:$sourceValid,imageIdentityEvidenceValid:$imageValid,migrationCompatibilityEvidenceValid:$migrationValid,composeEvidenceValid:$composeValid,rollbackPreconditionsSatisfied:$preconditions},
      warnings:(if $warning=="" then [] else [$warning] end)}'
}

rollback_status_observation_identity() {
  local current_root="" previous_root=""
  [ -d "$ZEDBOT_DEPLOYMENT_DIR" ] && [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ] || return 1
  printf 'state:%s\n' "$(stat -c '%d:%i:%u:%a' "$ZEDBOT_DEPLOYMENT_DIR" 2>/dev/null)" || return 1
  if [ -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] || [ -L "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ]; then
    rollback_status_safe_file "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
    printf 'current:%s:%s\n' "$(stat -c '%d:%i:%s:%Y:%Z' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")" "$(/usr/bin/sha256sum "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" | /usr/bin/awk '{print $1}')" || return 1
    current_root="$(/usr/bin/jq -er '.migrationEvidencePath' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" 2>/dev/null)" || return 1
    [ -d "$current_root" ] && [ ! -L "$current_root" ] || return 1
    printf 'current-evidence:%s\n' "$(stat -c '%d:%i:%Y:%Z' "$current_root")" || return 1
  fi
  if [ -e "$ZEDBOT_ROLLBACK_METADATA" ] || [ -L "$ZEDBOT_ROLLBACK_METADATA" ]; then
    rollback_status_safe_file "$ZEDBOT_ROLLBACK_METADATA" || return 1
    printf 'previous:%s:%s\n' "$(stat -c '%d:%i:%s:%Y:%Z' "$ZEDBOT_ROLLBACK_METADATA")" "$(/usr/bin/sha256sum "$ZEDBOT_ROLLBACK_METADATA" | /usr/bin/awk '{print $1}')" || return 1
    previous_root="$(/usr/bin/jq -er '.migrationEvidencePath' "$ZEDBOT_ROLLBACK_METADATA" 2>/dev/null)" || return 1
    [ -d "$previous_root" ] && [ ! -L "$previous_root" ] || return 1
    printf 'previous-evidence:%s\n' "$(stat -c '%d:%i:%Y:%Z' "$previous_root")" || return 1
  fi
}

rollback_status_validate_entry_set() {
  local entries="$1" current_gen="$2" previous_gen="$3" entry
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
      current.json|previous.json|bootstrap.json|legacy-install-v1.json) ;;
      "evidence-$current_gen"|"evidence-$previous_gen") ;;
      *) return 1 ;;
    esac
  done <<< "$entries"
}

inspect_rollback_status() {
  local entries current_gen="" previous_gen="" classification observation_before observation_after bootstrap_kind bootstrap_phase
  validate_deployment_path_contract >/dev/null 2>&1 || { rollback_status_emit indeterminate null UNSAFE_STATE_PATH "Canonical deployment state path is unsafe." unsafe false false false false false false false false; return 3; }
  if [ ! -e "$ZEDBOT_DEPLOYMENT_DIR" ]; then rollback_status_emit unavailable false FIRST_INSTALL_EMPTY "No canonical deployment history exists." genuine-first-install false false false false false false false false; return 2; fi
  [ -d "$ZEDBOT_DEPLOYMENT_DIR" ] && [ ! -L "$ZEDBOT_DEPLOYMENT_DIR" ] && [ "$(stat -c %u:%a "$ZEDBOT_DEPLOYMENT_DIR" 2>/dev/null)" = "0:700" ] || { rollback_status_emit indeterminate null UNSAFE_STATE_PATH "Canonical deployment state directory is unsafe." unsafe false false false false false false false false; return 3; }
  entries="$(installation_nonlock_entries 2>/dev/null)" || { rollback_status_emit indeterminate null INSPECTION_FAILED "Installation evidence could not be inspected safely." indeterminate false false false false false false false false; return 4; }
  if printf '%s\n' "$entries" | /usr/bin/grep -Eq '^(candidate-|failed\.json$|transition\.json$|operation-state\.json$)'; then
    rollback_status_emit blocked false OPERATION_INCOMPLETE "A deployment operation or unresolved generation is present." recoverable-operation false false false false false false false false
    return 2
  fi
  if [ -e "$ZEDBOT_LEGACY_INSTALLATION" ] || [ -L "$ZEDBOT_LEGACY_INSTALLATION" ]; then
    rollback_status_safe_file "$ZEDBOT_LEGACY_INSTALLATION" && validate_generation_metadata_core "$ZEDBOT_LEGACY_INSTALLATION" current >/dev/null 2>&1 && validate_generation_owned_evidence_readonly "$ZEDBOT_LEGACY_INSTALLATION" >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_LEGACY_EVIDENCE "Legacy installation evidence is invalid or unsupported." unsafe false false false false false false false false; return 3; }
    if [ ! -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ]; then rollback_status_emit blocked false LEGACY_NOT_CONVERTED "Supported legacy installation has not been converted." supported-legacy false false false false false false false false; return 2; fi
    rollback_status_safe_file "$ZEDBOT_INSTALLATION_BOOTSTRAP" && validate_installation_bootstrap >/dev/null 2>&1 || { rollback_status_emit indeterminate null MIXED_INSTALLATION_EVIDENCE "Canonical and legacy evidence are inconsistent." ambiguous false false false false false false false false; return 3; }
    [ "$(/usr/bin/jq -r '.kind+":"+.phase' "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = legacy-upgrade:promoted ] &&
      [ "$(/usr/bin/jq -r .generation "$ZEDBOT_LEGACY_INSTALLATION")" = "$(/usr/bin/jq -r .generation "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" 2>/dev/null)" ] || { rollback_status_emit indeterminate null MIXED_INSTALLATION_EVIDENCE "Canonical and legacy evidence are inconsistent." ambiguous false false false false false false false false; return 3; }
  fi
  if [ -e "$ZEDBOT_INSTALLATION_BOOTSTRAP" ] || [ -L "$ZEDBOT_INSTALLATION_BOOTSTRAP" ]; then
    if [ ! -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ]; then rollback_status_safe_file "$ZEDBOT_INSTALLATION_BOOTSTRAP" && validate_installation_bootstrap >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_BOOTSTRAP_EVIDENCE "Bootstrap evidence is invalid or unsafe." unsafe false false false false false false false false; return 3; }; rollback_status_emit blocked false OPERATION_INCOMPLETE "Installation bootstrap is incomplete." recoverable-bootstrap false false false false false false false false; return 2; fi
  fi
  if [ ! -e "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ] && [ ! -L "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" ]; then
    [ -z "$entries" ] && { rollback_status_emit unavailable false FIRST_INSTALL_EMPTY "No canonical deployment history exists." genuine-first-install false false false false false false false false; return 2; }
    rollback_status_emit indeterminate null PARTIAL_INSTALLATION_EVIDENCE "Installation evidence is partial or ambiguous." ambiguous false false false false false false false false; return 3
  fi
  rollback_status_safe_file "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" && validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_CURRENT_METADATA "Current generation metadata is invalid or unsafe." existing-canonical false false false false false false false false; return 3; }
  current_gen="$(/usr/bin/jq -r .generation "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")"
  validate_generation_owned_evidence_readonly "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_CURRENT_EVIDENCE "Current generation evidence is invalid or inconsistent." existing-canonical true false false false false false false false "$current_gen"; return 3; }
  if [ ! -e "$ZEDBOT_ROLLBACK_METADATA" ] && [ ! -L "$ZEDBOT_ROLLBACK_METADATA" ]; then rollback_status_emit unavailable false NO_PREVIOUS_GENERATION "No previous known-good generation is recorded." existing-canonical true false false true true true true false "$current_gen" "" "Operational image and database state require fresh locked rollback preflight."; return 2; fi
  rollback_status_safe_file "$ZEDBOT_ROLLBACK_METADATA" && validate_generation_metadata_core "$ZEDBOT_ROLLBACK_METADATA" previous >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_PREVIOUS_METADATA "Previous generation metadata is invalid or unsafe." existing-canonical true true false true false false false false "$current_gen"; return 3; }
  previous_gen="$(/usr/bin/jq -r .generation "$ZEDBOT_ROLLBACK_METADATA")"
  rollback_status_validate_entry_set "$entries" "$current_gen" "$previous_gen" || { rollback_status_emit indeterminate null PARTIAL_INSTALLATION_EVIDENCE "Installation evidence contains an unsupported or conflicting artifact." ambiguous true true true false false false false false "$current_gen" "$previous_gen"; return 3; }
  if [ -e "$ZEDBOT_INSTALLATION_BOOTSTRAP" ] || [ -L "$ZEDBOT_INSTALLATION_BOOTSTRAP" ]; then
    rollback_status_safe_file "$ZEDBOT_INSTALLATION_BOOTSTRAP" && validate_installation_bootstrap >/dev/null 2>&1 || { rollback_status_emit indeterminate null INVALID_BOOTSTRAP_EVIDENCE "Bootstrap evidence is invalid or unsafe." unsafe true true true false false false false false "$current_gen" "$previous_gen"; return 3; }
    bootstrap_kind="$(/usr/bin/jq -r .kind "$ZEDBOT_INSTALLATION_BOOTSTRAP")"; bootstrap_phase="$(/usr/bin/jq -r .phase "$ZEDBOT_INSTALLATION_BOOTSTRAP")"
    [ "$bootstrap_phase" = promoted ] && [ "$(/usr/bin/jq -r .generation "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = "$current_gen" ] || { rollback_status_emit blocked false OPERATION_INCOMPLETE "Installation bootstrap or upgrade is incomplete." recoverable-bootstrap true true true false false false false false "$current_gen" "$previous_gen"; return 2; }
    [ "$bootstrap_kind" = first-install ] || [ "$bootstrap_kind" = legacy-upgrade ] || return 3
  fi
  classification="existing-canonical"
  observation_before="$(rollback_status_observation_identity)" || { rollback_status_emit indeterminate null EVIDENCE_CHANGED "Canonical evidence could not be bound to one observation." existing-canonical true true true false false false false false "$current_gen" "$previous_gen"; return 3; }
  validate_rollback_eligibility_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" "$ZEDBOT_ROLLBACK_METADATA" || { rollback_status_emit blocked false ROLLBACK_EVIDENCE_MISMATCH "Current and previous rollback evidence is inconsistent." existing-canonical true true true false false false false false "$current_gen" "$previous_gen"; return 2; }
  observation_after="$(rollback_status_observation_identity)" || { rollback_status_emit indeterminate null EVIDENCE_CHANGED "Canonical evidence changed or disappeared during inspection." existing-canonical true true true false false false false false "$current_gen" "$previous_gen"; return 3; }
  [ "$observation_before" = "$observation_after" ] || { rollback_status_emit indeterminate null EVIDENCE_CHANGED "Canonical evidence changed during inspection." existing-canonical true true true false false false false false "$current_gen" "$previous_gen"; return 3; }
  rollback_status_emit available true ELIGIBLE "Canonical rollback evidence is complete; execution still requires fresh locked operational preflight." existing-canonical true true true true true true true true "$current_gen" "$previous_gen" "Image existence and live database state were not probed by read-only status."
}

rewrite_generation_state() {
  local file="$1" state="$2" current tmp attempted=true
  validate_generation_metadata_core "$file" candidate || return 1
  current="$(/usr/bin/jq -r '.state' "$file")" || return 1
  case "$current:$state" in
    prepared:application-recreated | prepared:failed-after-recreation | \
    application-recreated:failed-after-recreation | application-recreated:healthy-candidate | healthy-candidate:failed-after-recreation | \
    failed-after-recreation:rollback-failed | failed-after-recreation:rolled-back | \
    rollback-failed:rollback-failed | rollback-failed:rolled-back | \
    healthy-candidate:rolled-back) ;;
    *) log_error "Invalid generation transition: ${current} -> ${state}."; return 1 ;;
  esac
  [ "$state" = prepared ] && attempted=false
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.generation-state.XXXXXXXX")" || return 1
  if ! /usr/bin/jq --arg state "$state" --argjson attempted "$attempted" \
      '.state=$state|.recreationAttempted=$attempted|.healthConfirmed=($state=="healthy-candidate")' "$file" > "$tmp" || ! atomic_write_metadata "$tmp" "$file"; then
    rm -f "$tmp"; return 1
  fi
  rm -f "$tmp"
}

publish_failed_generation() {
  local candidate="$1" current="$2" state tmp
  validate_generation_metadata_core "$candidate" candidate || return 1
  validate_generation_metadata_core "$current" current || return 1
  state="$(/usr/bin/jq -r '.state' "$candidate")"
  case "$state" in failed-after-recreation | rollback-failed) ;; *) log_error "Only a failed deployed candidate is rollback-selectable."; return 1;; esac
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.failed-generation.XXXXXXXX")" || return 1
  /usr/bin/jq --slurpfile current "$current" '
    .lifecycleRole="failed" | .healthConfirmed=false |
    .rollbackTargetGeneration=$current[0].generation |
    .rollbackTargetImageId=$current[0].targetImageId
  ' "$candidate" > "$tmp" && atomic_write_metadata "$tmp" "$ZEDBOT_FAILED_DEPLOYMENT_METADATA"
  local rc=$?; rm -f "$tmp"; return "$rc"
}

metadata_transition_hook() { return 0; }

write_lifecycle_role() {
  local source="$1" role="$2" destination="$3" tmp
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.lifecycle-role.XXXXXXXX")" || return 1
  /usr/bin/jq --arg role "$role" '.lifecycleRole=$role|.state="known-good"|.healthConfirmed=true|.recreationAttempted=true' "$source" > "$tmp" &&
    atomic_write_metadata "$tmp" "$destination"
  local rc=$?; rm -f "$tmp"; return "$rc"
}

begin_metadata_transition() {
  local kind="$1" candidate="${2:-}" tmp source target candidate_sha=""
  [ ! -e "$ZEDBOT_METADATA_TRANSITION" ] && [ ! -L "$ZEDBOT_METADATA_TRANSITION" ] || { log_error "A metadata transition requires recovery."; return 1; }
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.transition.XXXXXXXX")" || return 1
  source="$(/usr/bin/jq -r '.generation' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")" || return 1
  if [ "$kind" = update ]; then
    target="$(/usr/bin/jq -r '.generation' "$candidate")" || return 1
    candidate_sha="$(/usr/bin/sha256sum "$candidate" | /usr/bin/awk '{print $1}')" || return 1
  else
    target="$(/usr/bin/jq -r '.generation' "$ZEDBOT_ROLLBACK_METADATA")" || return 1
  fi
  /usr/bin/jq -n --arg kind "$kind" --arg candidate "$candidate" --arg candidateSha256 "$candidate_sha" --arg sourceGeneration "$source" --arg targetGeneration "$target" \
    '{formatVersion:1,kind:$kind,phase:"prepared",candidatePath:$candidate,candidateSha256:$candidateSha256,sourceGeneration:$sourceGeneration,targetGeneration:$targetGeneration}' > "$tmp" &&
    atomic_write_metadata "$tmp" "$ZEDBOT_METADATA_TRANSITION"
  local rc=$?; rm -f "$tmp"; return "$rc"
}

advance_metadata_transition() {
  local phase="$1" tmp
  operation_assert_active || return 1
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.transition-phase.XXXXXXXX")" || return 1
  /usr/bin/jq --arg phase "$phase" '.phase=$phase' "$ZEDBOT_METADATA_TRANSITION" > "$tmp" && atomic_write_metadata "$tmp" "$ZEDBOT_METADATA_TRANSITION"
  local rc=$?; rm -f "$tmp"; return "$rc"
}

recover_metadata_transition() {
  local kind phase candidate candidate_sha source_generation target_generation current_generation
  operation_assert_active || return 1
  [ -e "$ZEDBOT_METADATA_TRANSITION" ] || return 0
  validate_state_regular_file "$ZEDBOT_METADATA_TRANSITION" || return 1
  /usr/bin/jq -e 'type=="object" and keys==["candidatePath","candidateSha256","formatVersion","kind","phase","sourceGeneration","targetGeneration"] and .formatVersion==1 and (.kind|IN("update","rollback")) and (.phase|IN("prepared","previous-written","current-written")) and (.candidatePath|type=="string") and (.candidateSha256|type=="string") and (.sourceGeneration|type=="string") and (.targetGeneration|type=="string")' "$ZEDBOT_METADATA_TRANSITION" >/dev/null || return 1
  kind="$(/usr/bin/jq -r .kind "$ZEDBOT_METADATA_TRANSITION")"; phase="$(/usr/bin/jq -r .phase "$ZEDBOT_METADATA_TRANSITION")"; candidate="$(/usr/bin/jq -r .candidatePath "$ZEDBOT_METADATA_TRANSITION")"
  candidate_sha="$(/usr/bin/jq -r .candidateSha256 "$ZEDBOT_METADATA_TRANSITION")"; source_generation="$(/usr/bin/jq -r .sourceGeneration "$ZEDBOT_METADATA_TRANSITION")"; target_generation="$(/usr/bin/jq -r .targetGeneration "$ZEDBOT_METADATA_TRANSITION")"
  if [ "$kind" = update ]; then
    validate_generation_metadata_core "$candidate" candidate || return 1
    [ "$(/usr/bin/sha256sum "$candidate" | /usr/bin/awk '{print $1}')" = "$candidate_sha" ] || { log_error "Candidate bytes changed during metadata transition."; return 1; }
    [ "$(/usr/bin/jq -r '.generation' "$candidate")" = "$target_generation" ] || return 1
    if [ "$phase" = prepared ]; then
      validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
      [ "$(/usr/bin/jq -r '.generation' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")" = "$source_generation" ] || return 1
      write_lifecycle_role "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" previous "$ZEDBOT_ROLLBACK_METADATA" || return 1
      metadata_transition_hook update-previous-written || return 1
      advance_metadata_transition previous-written || return 1
    fi
    write_lifecycle_role "$candidate" current "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
    metadata_transition_hook update-current-written || return 1
    remove_canonical_state_file "$candidate" || return 1
  else
    current_generation="$(/usr/bin/jq -r '.generation' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" 2>/dev/null || true)"
    if [ ! -e "$ZEDBOT_ROLLBACK_METADATA" ] && [ "$current_generation" = "$target_generation" ]; then
      validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
      remove_canonical_state_file "$ZEDBOT_METADATA_TRANSITION"; return 0
    fi
    validate_generation_metadata_core "$ZEDBOT_ROLLBACK_METADATA" previous || return 1
    [ "$(/usr/bin/jq -r '.generation' "$ZEDBOT_ROLLBACK_METADATA")" = "$target_generation" ] || return 1
    write_lifecycle_role "$ZEDBOT_ROLLBACK_METADATA" current "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || return 1
    metadata_transition_hook rollback-current-written || return 1
    remove_canonical_state_file "$ZEDBOT_ROLLBACK_METADATA" || return 1
  fi
  advance_metadata_transition current-written || return 1
  remove_canonical_state_file "$ZEDBOT_METADATA_TRANSITION"
}

promote_healthy_candidate() {
  local candidate="$1"
  validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
  validate_generation_metadata_core "$candidate" candidate || return 1
  [ "$(/usr/bin/jq -r '.state' "$candidate")" = healthy-candidate ] || { log_error "Only a health-confirmed candidate can be promoted."; return 1; }
  begin_metadata_transition update "$candidate" || return 1
  metadata_transition_hook update-prepared || return 1
  recover_metadata_transition
}

promote_successful_rollback() {
  validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || return 1
  validate_generation_metadata_core "$ZEDBOT_ROLLBACK_METADATA" previous || return 1
  begin_metadata_transition rollback "" || return 1
  metadata_transition_hook rollback-prepared || return 1
  recover_metadata_transition
}

select_rollback_generation() {
  recover_metadata_transition || return 1
  if [ -e "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ] || [ -L "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ]; then
    validate_generation_metadata_core "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" failed || return 1
  fi
  validate_generation_metadata_core "$ZEDBOT_ROLLBACK_METADATA" previous || return 1
  printf '%s\n' "$ZEDBOT_ROLLBACK_METADATA"
}

assert_no_unresolved_failed_generation() {
  local state
  [ ! -e "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ] && [ ! -L "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" ] && return 0
  validate_generation_metadata_core "$ZEDBOT_FAILED_DEPLOYMENT_METADATA" failed || return 1
  state="$(/usr/bin/jq -r '.state' "$ZEDBOT_FAILED_DEPLOYMENT_METADATA")"
  [ "$state" = rolled-back ] || { log_error "A failed deployed candidate requires rollback or operator resolution before another update."; return 1; }
}

retain_failed_target_image() {
  local target_id="$1" failed_tag="$2" actual existing
  valid_image_id "$target_id" || { log_error "Recorded target image ID is malformed."; return 1; }
  actual="$(run_clean_docker image inspect -f '{{.Id}}' "$target_id" 2>/dev/null)" || { log_error "Recorded target image no longer exists."; return 1; }
  [ "$actual" = "$target_id" ] || { log_error "Recorded target image identity changed."; return 1; }
  existing="$(run_clean_docker image inspect -f '{{.Id}}' "$failed_tag" 2>/dev/null || true)"
  [ -z "$existing" ] || [ "$existing" = "$target_id" ] || { log_error "Failed-target tag already identifies another image."; return 1; }
  if [ -z "$existing" ]; then
    run_clean_docker image tag "$target_id" "$failed_tag" || return 1
  fi
  [ "$(run_clean_docker image inspect -f '{{.Id}}' "$failed_tag" 2>/dev/null)" = "$target_id" ] || { log_error "Failed-target tag identity could not be retained."; return 1; }
}

retain_known_good_image() {
  local image_id="$1" tag="$2" actual existing
  valid_image_id "$image_id" || { log_error "Known-good image ID is malformed."; return 1; }
  actual="$(run_clean_docker image inspect -f '{{.Id}}' "$image_id" 2>/dev/null)" || { log_error "Known-good image no longer exists."; return 1; }
  [ "$actual" = "$image_id" ] || { log_error "Known-good image identity changed."; return 1; }
  existing="$(run_clean_docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null || true)"
  [ -z "$existing" ] || [ "$existing" = "$image_id" ] || { log_error "Generation rollback tag already identifies another image."; return 1; }
  if [ -z "$existing" ]; then
    run_clean_docker image tag "$image_id" "$tag" || return 1
  fi
  [ "$(run_clean_docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null)" = "$image_id" ] || { log_error "Known-good image tag identity could not be retained."; return 1; }
}

validate_retained_generation_image() {
  local metadata="$1" expected_id tag actual
  validate_generation_metadata_core "$metadata" previous || return 1
  expected_id="$(/usr/bin/jq -r '.targetImageId' "$metadata")"
  tag="$(/usr/bin/jq -r '.immutableImageTag' "$metadata")"
  actual="$(run_clean_docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null)" || { log_error "Previous generation image reference is missing."; return 1; }
  [ "$actual" = "$expected_id" ] || { log_error "Previous generation image reference does not match its recorded immutable image ID."; return 1; }
}

execute_validated_rollback_transition() {
  local metadata="$1" target_sha target_id
  [ "$metadata" = "$ZEDBOT_ROLLBACK_METADATA" ] || { log_error "Rollback metadata must be canonical previous.json."; return 1; }
  validate_generation_metadata_core "$metadata" previous || return 1
  validate_generation_owned_evidence "$metadata" || return 1
  validate_retained_generation_image "$metadata" || return 1
  target_sha="$(/usr/bin/jq -r '.targetDeploySha' "$metadata")"; target_id="$(/usr/bin/jq -r '.targetImageId' "$metadata")"
  recreate_application_services || return 1
  verify_application_recreation_set "$target_id" || return 1
  record_bot_recreation_boundary "$target_id" "$target_sha" || return 1
  metadata_transition_hook rollback-recreated || return 1
  confirm_operation_state compatibility-confirmed application-recreated || return 1
  validate_running_application "$target_sha" >/dev/null || return 1
  metadata_transition_hook rollback-health-confirmed || return 1
  confirm_operation_state application-recreated health-confirmed || return 1
  begin_metadata_transition rollback "" || return 1
  confirm_operation_state health-confirmed promotion-prepared || return 1
  recover_metadata_transition || return 1
  confirm_operation_state promotion-prepared promoted || return 1
  finalize_promoted_operation_state
}

retag_validated_previous_reference() {
  local metadata="$1" target_id
  validate_retained_generation_image "$metadata" || return 1
  target_id="$(/usr/bin/jq -r '.targetImageId' "$metadata")"
  run_clean_docker image tag "$target_id" zedbot-app:latest || return 1
  [ "$(run_clean_docker image inspect -f '{{.Id}}' zedbot-app:latest 2>/dev/null)" = "$target_id" ] || { log_error "Rollback deployment reference retag was not confirmed."; return 1; }
}

# --- Interaction -------------------------------------------------------------
# confirm "<question>" [y|n]
# Returns 0 for yes, 1 for no. The second argument is the default answer,
# used when the user presses ENTER, when no terminal is available, or when
# ZEDBOT_NONINTERACTIVE=1 is set.
confirm() {
  local prompt="${1:-Are you sure?}" default="${2:-n}" suffix reply=""
  case "$default" in
    y | Y) suffix="[Y/n]" ;;
    *)     suffix="[y/N]" ;;
  esac
  if [ "${ZEDBOT_NONINTERACTIVE:-0}" = "1" ]; then
    log_warn "Non-interactive mode: \"${prompt}\" -> ${default}"
  elif ( : </dev/tty ) 2>/dev/null; then
    read -r -p "${prompt} ${suffix} " reply </dev/tty || reply=""
  elif [ -t 0 ]; then
    read -r -p "${prompt} ${suffix} " reply || reply=""
  else
    log_warn "No terminal available: \"${prompt}\" -> ${default}"
  fi
  reply="${reply:-$default}"
  case "$reply" in
    y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Environment -------------------------------------------------------------
# Sources the .env file into the current shell (exported) when present.
# Never fails, so it is safe to call under `set -e` even before install.
load_env_if_exists() {
  local env_file="${1:-$ZEDBOT_ENV_FILE}"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
  return 0
}

# Conventional alias for load_env_if_exists.
load_env() {
  load_env_if_exists "$@"
}

# True when the Docker CLI is present and the daemon answers.
check_docker() {
  has_command docker && run_clean_docker info >/dev/null 2>&1
}

# --- Migrations --------------------------------------------------------------
# The placeholder services ship no migrations yet. When real migrations land
# they should be exposed as an executable scripts/migrate.sh; this hook picks
# them up automatically without breaking installs that predate them.
run_migrations_if_available() {
  if [ -x "${ZEDBOT_APP_DIR}/scripts/migrate.sh" ]; then
    log_info "Running database migrations ..."
    if "${ZEDBOT_APP_DIR}/scripts/migrate.sh"; then
      log_success "Database migrations completed."
    else
      log_warn "Database migrations reported an error. Check 'zedbot logs' for details."
    fi
  else
    log_info "No migration command found - skipping (nothing to migrate yet)."
  fi
}

# --- Deployment identity / legacy self-heal ----------------------------------
# Helpers for the self-healing update flow: installations that predate the
# persistent-backup layout (PR #92) keep an old installed CLI, an old .env
# and stale containers after `zedbot update`. These helpers converge them.
# All idempotent; none ever prints a secret.

# Prints the repository HEAD SHA; prints nothing (and still returns 0) when
# it cannot be determined. Deployment never mutates local or global Git config;
# the installer/operator must establish any required safe.directory policy.
repo_head_sha() {
  git -C "$ZEDBOT_APP_DIR" rev-parse HEAD 2>/dev/null || true
}

# Converts the supported HTTPS/SCP-style/ssh GitHub spellings to one identity.
# Nothing else is accepted: no ports, credentials, subdomains, URL suffixes,
# forks, or lookalike repository names.
canonical_origin_identity() {
  case "${1:-}" in
    https://github.com/Mhoseinshah1/ZED_BOT|https://github.com/Mhoseinshah1/ZED_BOT.git|git@github.com:Mhoseinshah1/ZED_BOT|git@github.com:Mhoseinshah1/ZED_BOT.git|ssh://git@github.com/Mhoseinshah1/ZED_BOT|ssh://git@github.com/Mhoseinshah1/ZED_BOT.git)
      printf '%s\n' "$ZEDBOT_CANONICAL_REPO_URL"
      ;;
    *) return 1 ;;
  esac
}

# Verifies the mutable checkout identity without changing it. Ignored paths are
# deliberately excluded: node_modules, dist, coverage and similar ignored
# dependencies/build output cannot enter the commit-derived snapshot. Every
# staged, tracked, or non-ignored untracked path is a build-context overlay and
# is rejected.
verify_deployment_checkout() {
  local expected_sha="$1" expected_tree="$2" origin branch head remote tree status
  origin="$(git -C "$ZEDBOT_APP_DIR" config --get remote.origin.url 2>/dev/null)" || return 1
  canonical_origin_identity "$origin" >/dev/null || { log_error "origin is not the canonical Mhoseinshah1/ZED_BOT repository."; return 1; }
  branch="$(git -C "$ZEDBOT_APP_DIR" symbolic-ref --short -q HEAD 2>/dev/null)" || {
    log_error "Deployment checkout is detached; main is required."; return 1;
  }
  [ "$branch" = main ] || { log_error "Deployment checkout branch must be main."; return 1; }
  head="$(git -C "$ZEDBOT_APP_DIR" rev-parse --verify HEAD 2>/dev/null)" || return 1
  remote="$(git -C "$ZEDBOT_APP_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null)" || return 1
  [ "$head" = "$expected_sha" ] && [ "$remote" = "$expected_sha" ] || {
    log_error "Local main must exactly equal the fetched origin/main; the updater does not fast-forward the checkout."; return 1;
  }
  tree="$(git -C "$ZEDBOT_APP_DIR" rev-parse --verify 'HEAD^{tree}' 2>/dev/null)" || return 1
  [ "$tree" = "$expected_tree" ] || { log_error "Deployment checkout tree identity changed."; return 1; }
  status="$(git -C "$ZEDBOT_APP_DIR" status --porcelain=v1 --untracked-files=all 2>/dev/null)" || return 1
  [ -z "$status" ] || { log_error "Deployment checkout contains staged, tracked, or non-ignored untracked build overlays."; return 1; }
}

# Fetches but never fast-forwards or otherwise mutates the deployment checkout.
# The local main checkout must already be the exact fetched origin/main commit.
prepare_exact_origin_main() (
  local target origin snapshot tree
  snapshot=""
  trap '[ -z "$snapshot" ] || { chmod -R u+w "$snapshot" 2>/dev/null || true; git -C "$ZEDBOT_APP_DIR" worktree remove --force "$snapshot" 2>/dev/null || true; }' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  origin="$(git -C "$ZEDBOT_APP_DIR" config --get remote.origin.url 2>/dev/null)"
  canonical_origin_identity "$origin" >/dev/null || { log_error "origin is not the canonical Mhoseinshah1/ZED_BOT repository."; return 1; }
  git -C "$ZEDBOT_APP_DIR" fetch origin main || return 1
  target="$(git -C "$ZEDBOT_APP_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null)"
  valid_git_sha "$target" || return 1
  tree="$(git -C "$ZEDBOT_APP_DIR" rev-parse --verify "$target^{tree}")" || return 1
  verify_deployment_checkout "$target" "$tree" || return 1
  snapshot="$(mktemp -d "${TMPDIR:-/tmp}/zedbot-source.XXXXXXXX")" || return 1
  git -C "$ZEDBOT_APP_DIR" worktree add --detach "$snapshot" "$target" >/dev/null || { rmdir "$snapshot"; return 1; }
  if ! verify_source_snapshot "$snapshot" "$target" "$tree"; then
    git -C "$ZEDBOT_APP_DIR" worktree remove --force "$snapshot"; return 1;
  fi
  chmod -R a-w "$snapshot"
  verify_source_snapshot "$snapshot" "$target" "$tree" || { chmod -R u+w "$snapshot"; git -C "$ZEDBOT_APP_DIR" worktree remove --force "$snapshot"; return 1; }
  trap - EXIT INT TERM HUP
  printf '%s %s %s\n' "$target" "$tree" "$snapshot"
)

verify_source_snapshot() {
  local snapshot="$1" sha="$2" tree="$3" actual_tree
  case "$snapshot" in "${TMPDIR:-/tmp}"/zedbot-source.*) ;; *) return 1;; esac
  [ -d "$snapshot/.git" ] || [ -f "$snapshot/.git" ] || return 1
  [ "$(git -C "$snapshot" rev-parse --verify HEAD)" = "$sha" ] || return 1
  [ "$(git -C "$snapshot" rev-parse --verify 'HEAD^{tree}')" = "$tree" ] || return 1
  [ -z "$(git -C "$snapshot" status --porcelain=v1 --untracked-files=all)" ] || return 1
  # write-tree reconstructs identity from the snapshot index plus its exact
  # working-tree bytes; it detects content, executable-bit and path changes.
  actual_tree="$(git -C "$snapshot" add --refresh >/dev/null 2>&1 && git -C "$snapshot" write-tree)" || return 1
  [ "$actual_tree" = "$tree" ]
}

require_source_integrity() {
  local sha="$1" tree="$2" snapshot="$3"
  verify_deployment_checkout "$sha" "$tree" || return 1
  verify_source_snapshot "$snapshot" "$sha" "$tree" || return 1
}

build_verified_source_snapshot() {
  local sha="$1" tree="$2" snapshot="$3"
  require_source_integrity "$sha" "$tree" "$snapshot" || return 1
  run_clean_docker build --pull=false --build-arg "GIT_SHA=$sha" \
    --build-arg "VITE_BOT_USERNAME=${VITE_BOT_USERNAME:-}" -t zedbot-app:latest "$snapshot"
}

SOURCE_SNAPSHOT_OWNED_PATH=""
SOURCE_SNAPSHOT_OWNED_INODE=""
register_source_snapshot() {
  local snapshot="$1" sha="$2" tree="$3"
  verify_source_snapshot "$snapshot" "$sha" "$tree" || return 1
  SOURCE_SNAPSHOT_OWNED_PATH="$snapshot"
  SOURCE_SNAPSHOT_OWNED_INODE="$(stat -Lc '%d:%i' "$snapshot")" || return 1
}

cleanup_source_snapshot() {
  local snapshot="${1:-}" expected_sha="${2:-}" expected_tree="${3:-}" git_common actual_common
  case "$snapshot" in "${TMPDIR:-/tmp}"/zedbot-source.*) ;; *) return 0;; esac
  [ -n "$expected_sha" ] && [ -n "$expected_tree" ] || return 0
  [ "$snapshot" = "$SOURCE_SNAPSHOT_OWNED_PATH" ] || return 0
  [ -e "$snapshot" ] || return 0
  [ "$(stat -Lc '%d:%i' "$snapshot" 2>/dev/null)" = "$SOURCE_SNAPSHOT_OWNED_INODE" ] || return 0
  git_common="$(git -C "$ZEDBOT_APP_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  actual_common="$(git -C "$snapshot" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  [ "$actual_common" = "$git_common" ] || return 0
  [ "$(git -C "$snapshot" rev-parse --verify HEAD 2>/dev/null)" = "$expected_sha" ] || return 0
  [ "$(git -C "$snapshot" rev-parse --verify 'HEAD^{tree}' 2>/dev/null)" = "$expected_tree" ] || return 0
  chmod -R u+w "$snapshot" 2>/dev/null || return 0
  git -C "$ZEDBOT_APP_DIR" worktree remove --force "$snapshot" 2>/dev/null || true
  SOURCE_SNAPSHOT_OWNED_PATH=""
  SOURCE_SNAPSHOT_OWNED_INODE=""
}

# True when the installed CLI (ZEDBOT_CLI_PATH) is missing or its content
# differs from the repository's scripts/zedbot.sh.
cli_is_stale() {
  local src="${ZEDBOT_APP_DIR}/scripts/zedbot.sh"
  [ -f "$ZEDBOT_CLI_PATH" ] || return 0
  # Without a repository copy there is nothing to compare against (or to
  # refresh from) - treat the installed CLI as current.
  [ -f "$src" ] || return 1
  local installed_sha repo_sha
  installed_sha="$(sha256sum "$ZEDBOT_CLI_PATH" 2>/dev/null | awk '{print $1}')"
  repo_sha="$(sha256sum "$src" 2>/dev/null | awk '{print $1}')"
  [ -z "$installed_sha" ] || [ -z "$repo_sha" ] || [ "$installed_sha" != "$repo_sha" ]
}

# Reinstalls the CLI from the repository copy and verifies the result byte
# for byte. Non-zero on any failure.
refresh_cli() {
  local src="${ZEDBOT_APP_DIR}/scripts/zedbot.sh"
  if [ ! -f "$src" ]; then
    log_error "Cannot refresh the CLI: ${src} does not exist."
    return 1
  fi
  if ! install -m 0755 "$src" "$ZEDBOT_CLI_PATH"; then
    log_error "Could not install ${src} to ${ZEDBOT_CLI_PATH}."
    return 1
  fi
  if cli_is_stale; then
    log_error "CLI refresh verification failed: ${ZEDBOT_CLI_PATH} still differs from ${src}."
    return 1
  fi
  log_success "Installed CLI refreshed: ${ZEDBOT_CLI_PATH}"
}

# APPEND-ONLY .env migration for installations that predate the persistent
# backup layout: existing lines are never rewritten, reordered or deleted,
# the file is never replaced, and its mode stays 600. Only missing keys are
# appended (with a comment header). Returns 0 always - a skipped migration
# must never abort an update; `zedbot env-check` reports real problems.
migrate_legacy_env() {
  local env_file="${1:-$ZEDBOT_ENV_FILE}"
  if [ ! -f "$env_file" ]; then
    log_warn "No .env at ${env_file} - skipping the legacy .env migration."
    return 0
  fi

  local -a append_lines=()
  local -a append_keys=()

  # ZEDBOT_BACKUP_DIR (HOST backup path): honor a legacy BACKUP_DIR that
  # points at a custom absolute host path (pre-PR92 semantics: BACKUP_DIR
  # WAS the host location). The in-container mount path must never be
  # mistaken for a host directory.
  if ! grep -q '^ZEDBOT_BACKUP_DIR=' "$env_file"; then
    local legacy_dir backup_dir_value
    legacy_dir="$(grep '^BACKUP_DIR=' "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "'\"" || true)"
    backup_dir_value="${ZEDBOT_BASE_DIR}/backups"
    case "$legacy_dir" in
      /var/lib/zedbot/backups) : ;; # the in-container path, not a host dir
      /*) backup_dir_value="$legacy_dir" ;;
    esac
    append_lines+=("ZEDBOT_BACKUP_DIR=${backup_dir_value}")
    append_keys+=("ZEDBOT_BACKUP_DIR")
  fi

  local pair key
  for pair in \
    "ZEDBOT_RUNTIME_UID=1000" \
    "ZEDBOT_RUNTIME_GID=1000" \
    "BACKUP_RETENTION_DAYS=14" \
    "BACKUP_MIN_RETAINED=3" \
    "BACKUP_MAX_TELEGRAM_MB=45" \
    "BACKUP_MIN_FREE_DISK_MB=500"; do
    key="${pair%%=*}"
    if ! grep -q "^${key}=" "$env_file"; then
      append_lines+=("$pair")
      append_keys+=("$key")
    fi
  done

  if [ "${#append_lines[@]}" -eq 0 ]; then
    log_info ".env already carries all persistent-backup keys - nothing to migrate."
    return 0
  fi

  {
    printf '\n# Persistent backup storage (added by zedbot update)\n'
    printf '%s\n' "${append_lines[@]}"
  } >> "$env_file"
  chmod 600 "$env_file"
  log_success ".env migrated (append-only) - added: ${append_keys[*]}"
  return 0
}

# Records the repository HEAD SHA into the database Settings via the
# worker's record-deploy CLI. Best effort: failures are logged but never
# abort the caller - a deploy must not fail on a bookkeeping write.
record_deployed_sha() {
  local sha="${1:-}"
  [ -n "$sha" ] || sha="$(repo_head_sha)"
  if [ -z "$sha" ]; then
    log_warn "Could not determine the repository HEAD SHA - deployed version not recorded."
    return 0
  fi
  if run_compose run --rm --no-deps worker node apps/worker/dist/cli/record-deploy.js "$sha"; then
    log_success "Deployed repository SHA recorded (${sha})."
  else
    log_warn "Could not record the deployed SHA in the database (non-fatal)."
    log_warn "It will be recorded by the next successful 'zedbot update'."
  fi
  return 0
}

# True on an installation the pre-PR92 updater left half-upgraded: the .env
# still lacks the persistent-backup keys, or the installed CLI is stale.
legacy_install_detected() {
  if [ -f "$ZEDBOT_ENV_FILE" ] && ! grep -q '^ZEDBOT_BACKUP_DIR=' "$ZEDBOT_ENV_FILE"; then
    return 0
  fi
  cli_is_stale
}

# --- Nginx / HTTPS (Phase 37) ------------------------------------------------

# Consumed by the sourcing scripts (nginx-setup.sh, ssl-setup.sh,
# security-check.sh) - shellcheck cannot see that from this file alone.
# shellcheck disable=SC2034
ZEDBOT_NGINX_SITE_AVAILABLE="/etc/nginx/sites-available/zedbot.conf"
# shellcheck disable=SC2034
ZEDBOT_NGINX_SITE_ENABLED="/etc/nginx/sites-enabled/zedbot.conf"
ZEDBOT_ACME_WEBROOT="/var/www/letsencrypt"

# Conservative hostname check: dot-separated labels, alphabetic TLD.
# Rejects URLs, IPs, shell metacharacters and empty input.
is_valid_domain() {
  local domain="$1"
  [ -n "$domain" ] || return 1
  [ "${#domain}" -le 253 ] || return 1
  printf '%s' "$domain" \
    | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$'
}

is_valid_port() {
  local port="$1"
  printf '%s' "$port" | grep -Eq '^[0-9]+$' || return 1
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

# HTTP-only site (pre-certificate): ACME webroot + plain proxy.
render_nginx_http_config() {
  local domain="$1" port="$2"
  cat <<NGINX
# ZED_BOT reverse proxy (HTTP-only bootstrap - run 'zedbot ssl' for HTTPS).
# Generated by scripts/nginx-setup.sh - edits are overwritten on re-run.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    server_tokens off;

    location /.well-known/acme-challenge/ {
        root ${ZEDBOT_ACME_WEBROOT};
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
}

# HTTPS site: port 80 redirects (except ACME), 443 terminates TLS.
render_nginx_https_config() {
  local domain="$1" port="$2"
  local extra_ssl_include=""
  if [ -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
    extra_ssl_include="    include /etc/letsencrypt/options-ssl-nginx.conf;"
  fi
  cat <<NGINX
# ZED_BOT reverse proxy (HTTPS).
# Generated by scripts/ssl-setup.sh - edits are overwritten on re-run.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    server_tokens off;

    location /.well-known/acme-challenge/ {
        root ${ZEDBOT_ACME_WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    # HTTP/2 is requested on the listen line, NOT with the standalone \`http2 on;\`
    # directive. That directive only exists from nginx 1.25.1; the Ubuntu LTS
    # release this project installs on ships 1.24, where it is an unknown
    # directive and \`nginx -t\` fails outright — so the reverse proxy never comes
    # up and the whole panel is unreachable behind a config that looks fine in a
    # diff. The \`listen ... http2\` form has worked since 1.9.5 and is merely
    # deprecated (a warning, not an error) on newer builds, so it is the only
    # spelling that is correct on every version this repository targets.
    #
    # Exactly one style, never both: nginx rejects a server block that requests
    # HTTP/2 twice.
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};
    server_tokens off;

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
${extra_ssl_include}

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 20m;

    # --- Telegram Mini App: the ONE framing exception -------------------------
    #
    # Everything else on this host keeps 'X-Frame-Options: DENY' from the server
    # block above. The Mini App cannot: Telegram Desktop and Telegram Web render
    # it inside an iframe, and DENY makes it a blank box on both.
    #
    # This location must re-declare EVERY header. Nginx's add_header inheritance
    # is all-or-nothing per level: a location that declares any add_header of
    # its own inherits NONE from the enclosing server. That is exactly how DENY
    # is dropped here and nowhere else - and it is also why forgetting to repeat
    # nosniff, Referrer-Policy or HSTS below would silently remove them from
    # every Mini App response.
    #
    # The regex matches '/miniapp' and '/miniapp/...' and NOTHING else. It does
    # not match '/miniappfoo', and it cannot match '/api/miniapp/...' - the JSON
    # API keeps DENY. Nginx normalises '.' and '..' segments BEFORE matching, so
    # a path-confusion attempt like '/miniapp/../api/miniapp/me' is resolved to
    # '/api/miniapp/me' and lands in 'location /' with the strict headers. The
    # proxy_pass below deliberately carries NO URI part, so the path reaches the
    # API verbatim: '/miniapp/api/...' stays '/miniapp/api/...' (a 404) and can
    # never be rewritten into '/api/miniapp/...'.
    location ~ ^/miniapp(/|\$) {
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        # X-Frame-Options is INTENTIONALLY ABSENT. Framing is governed by
        # frame-ancestors below, which is the more precise of the two mechanisms
        # and the one browsers prefer when both are present. Re-adding DENY here
        # would override it and break the app.
        #
        # frame-ancestors names Telegram's web clients explicitly - no wildcard,
        # no '*'. The native Android/iOS/desktop clients open the Mini App as a
        # TOP-LEVEL document, where frame-ancestors does not apply at all, so
        # they are unaffected by this list.
        #
        # script-src names telegram.org because the WebApp bridge
        # (/js/telegram-web-app.js) is what defines window.Telegram inside the
        # iframe clients; there is no other third-party origin. No 'unsafe-eval'
        # and no 'unsafe-inline': the bundle ships its CSS as a file and sets
        # dynamic styles through the CSSOM, which CSP does not restrict.
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org; base-uri 'none'; form-action 'none'; object-src 'none'" always;

        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
NGINX
}

# nginx -t, then reload (systemd, sysvinit or a bare nginx binary).
test_and_reload_nginx() {
  if ! nginx -t; then
    log_error "nginx -t failed - the configuration was NOT reloaded."
    return 1
  fi
  if has_command systemctl && systemctl reload nginx 2>/dev/null; then
    log_success "Nginx reloaded."
  elif has_command service && service nginx reload 2>/dev/null; then
    log_success "Nginx reloaded."
  else
    nginx -s reload
    log_success "Nginx reloaded."
  fi
}
