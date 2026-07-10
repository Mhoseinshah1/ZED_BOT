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
# BACKUP_DIR (from .env) takes precedence so operators can relocate backups.
ZEDBOT_BACKUP_DIR="${BACKUP_DIR:-${ZEDBOT_BACKUP_DIR:-${ZEDBOT_BASE_DIR}/backups}}"
ZEDBOT_LOGS_DIR="${ZEDBOT_LOGS_DIR:-${ZEDBOT_BASE_DIR}/logs}"
ZEDBOT_ENV_FILE="${ZEDBOT_ENV_FILE:-${ZEDBOT_APP_DIR}/.env}"
ZEDBOT_REPO_URL="${ZEDBOT_REPO_URL:-https://github.com/Mhoseinshah1/ZED_BOT.git}"
ZEDBOT_CLI_PATH="${ZEDBOT_CLI_PATH:-/usr/local/bin/zedbot}"

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

# --- Small utilities ---------------------------------------------------------
has_command() { command -v "$1" >/dev/null 2>&1; }

timestamp() { date +%Y%m%d-%H%M%S; }

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

generate_password() {
  # Hex output only: safe in the shell, in .env files and in connection URLs.
  if has_command openssl; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# --- Docker Compose ----------------------------------------------------------
COMPOSE_CMD=()

# Standalone docker-compose binaries are only usable when they are v2+; the
# legacy python docker-compose 1.x cannot parse this project's compose file
# (versionless Compose spec with a top-level "name:").
docker_compose_binary_is_v2() {
  has_command docker-compose &&
    docker-compose version --short 2>/dev/null | grep -qE '^v?2'
}

detect_compose_command() {
  if [ "${#COMPOSE_CMD[@]}" -gt 0 ]; then
    return 0
  fi
  if ! has_command docker; then
    log_error "Docker is not installed. Run the ZED_BOT installer first:"
    log_error "  bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)"
    return 1
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif docker_compose_binary_is_v2; then
    COMPOSE_CMD=(docker-compose)
  else
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

# Runs docker compose from the app directory without changing the caller's
# working directory.
run_compose() {
  detect_compose_command || return 1
  ( app_cd && "${COMPOSE_CMD[@]}" "$@" )
}

compose_service_running() {
  local service="$1" cid
  cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 1 || true)"
  [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" = "true" ]
}

wait_for_service_healthy() {
  local service="$1" timeout="${2:-90}" waited=0 cid state
  while [ "$waited" -lt "$timeout" ]; do
    cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 1 || true)"
    if [ -n "$cid" ]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      case "$state" in
        healthy | running) return 0 ;;
      esac
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
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
  has_command docker && docker info >/dev/null 2>&1
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
