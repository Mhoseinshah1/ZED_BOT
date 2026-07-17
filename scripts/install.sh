#!/usr/bin/env bash
# =============================================================================
# ZED_BOT installer for Ubuntu 24.04 / 26.04
# (Ubuntu 22.04 is accepted on a best-effort basis only.)
#
# Usage (as root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
#
# This script is intentionally self-contained (it does not source
# scripts/lib/common.sh) because it runs before the repository is cloned.
# Keep its helpers behaviourally in sync with scripts/lib/common.sh.
#
# Idempotent: safe to re-run on an already-installed server. Existing .env,
# data and backups are preserved unless you explicitly choose otherwise.
#
# Optional environment overrides (useful for automation/testing):
#   ZEDBOT_BRANCH                 git branch to install (default: main)
#   ZEDBOT_NONINTERACTIVE=1       never prompt; use defaults / the vars below
#   ZEDBOT_TELEGRAM_BOT_TOKEN     preseed TELEGRAM_BOT_TOKEN
#   ZEDBOT_ADMIN_TELEGRAM_IDS     preseed ADMIN_TELEGRAM_IDS
#   ZEDBOT_APP_DOMAIN             preseed APP_DOMAIN (required in non-interactive mode)
#   ZEDBOT_SSL_EMAIL              preseed SSL_EMAIL (default: admin@<domain>)
#   ZEDBOT_POSTGRES_PASSWORD      preseed POSTGRES_PASSWORD
#   ZEDBOT_REDIS_PASSWORD         preseed REDIS_PASSWORD
# =============================================================================

set -Eeuo pipefail

# --- Configuration -----------------------------------------------------------
ZEDBOT_BASE_DIR="${ZEDBOT_BASE_DIR:-/opt/zedbot}"
APP_DIR="${ZEDBOT_APP_DIR:-${ZEDBOT_BASE_DIR}/app}"
DATA_DIR="${ZEDBOT_DATA_DIR:-${ZEDBOT_BASE_DIR}/data}"
# HOST backup directory (the containers see it as /var/lib/zedbot/backups).
HOST_BACKUP_DIR="${ZEDBOT_BACKUP_DIR:-${ZEDBOT_BASE_DIR}/backups}"
LOGS_DIR="${ZEDBOT_LOGS_DIR:-${ZEDBOT_BASE_DIR}/logs}"
# UID/GID of the unprivileged user the app containers run as (node in the
# image). The backup directory is handed to this owner so the worker (rw
# mount) and bot (ro mount) can use it.
RUNTIME_UID="${ZEDBOT_RUNTIME_UID:-1000}"
RUNTIME_GID="${ZEDBOT_RUNTIME_GID:-1000}"
ENV_FILE="${APP_DIR}/.env"
REPO_URL="${ZEDBOT_REPO_URL:-https://github.com/Mhoseinshah1/ZED_BOT.git}"
REPO_BRANCH="${ZEDBOT_BRANCH:-main}"
CLI_PATH="/usr/local/bin/zedbot"

export DEBIAN_FRONTEND=noninteractive

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

on_error() {
  log_error "Installation failed (around line $1). Fix the issue above and re-run the installer."
  log_error "Re-running the installer is safe: existing configuration and data are preserved."
}
trap 'on_error $LINENO' ERR

# --- Helpers -----------------------------------------------------------------
has_command() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_error "The ZED_BOT installer must be run as root. Try again with sudo."
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
      log_warn "Detected ${os_pretty}. Ubuntu 22.04 is supported on a best-effort basis only;"
      log_warn "the primary targets are Ubuntu 24.04 and 26.04. Continuing."
      ;;
    *)
      log_warn "Detected ${os_pretty}. ZED_BOT supports Ubuntu 24.04 and 26.04."
      if ! confirm "Continue on this unsupported Ubuntu version anyway?" "n"; then
        log_error "Installation cancelled: unsupported Ubuntu version."
        exit 1
      fi
      ;;
  esac
}

generate_password() {
  # Hex output only: safe in the shell, in .env files and in connection URLs.
  if has_command openssl; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Strips characters that would break .env parsing (quotes, backslashes,
# CR/LF). The values collected here (tokens, ids, hostnames, passwords) never
# legitimately contain them; a trailing backslash in particular would make
# docker compose's dotenv parser swallow the following line into the value.
sanitize_value() {
  printf '%s' "$1" | tr -d "\r\n'\"\\\\"
}

# Percent-encodes a string for safe embedding in connection URLs.
urlencode() {
  local s="$1" out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

can_prompt() {
  [ "${ZEDBOT_NONINTERACTIVE:-0}" != "1" ] && ( : </dev/tty ) 2>/dev/null
}

# prompt_value "<label>" "<default>" -> echoes the answer (default on ENTER)
prompt_value() {
  local label="$1" default="${2:-}" value=""
  if ! can_prompt; then
    printf '%s' "$default"
    return 0
  fi
  if [ -n "$default" ]; then
    read -r -p "${label} [${default}]: " value </dev/tty || value=""
  else
    read -r -p "${label}: " value </dev/tty || value=""
  fi
  printf '%s' "${value:-$default}"
}

# prompt_secret "<label>" "<default>" -> like prompt_value but hides input
# and never echoes the default (it may be a secret).
prompt_secret() {
  local label="$1" default="${2:-}" value=""
  if ! can_prompt; then
    printf '%s' "$default"
    return 0
  fi
  read -r -s -p "${label}: " value </dev/tty || value=""
  printf '\n' >&2
  printf '%s' "${value:-$default}"
}

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

# --- Installation steps ------------------------------------------------------
# Waits for concurrent apt/dpkg users (apt-daily, unattended-upgrades) instead
# of failing immediately - fresh servers routinely hold the lock right after
# boot.
apt_get() {
  apt-get -o DPkg::Lock::Timeout=120 "$@"
}

install_base_packages() {
  log_info "Installing base packages (curl, git, ca-certificates, gnupg, lsb-release, jq, unzip, zip, openssl, ufw) ..."
  apt_get update -y -q
  # ufw is installed for later hardening phases but is NOT enabled or
  # reconfigured here - changing firewall rules unprompted could cut SSH.
  apt_get install -y -q curl git ca-certificates gnupg lsb-release jq unzip zip openssl ufw
  log_success "Base packages installed."
}

install_docker() {
  if has_command docker; then
    log_info "Docker is already installed: $(docker --version 2>/dev/null || echo 'unknown version')"
  else
    log_info "Installing Docker Engine from the official Docker repository ..."
    install -m 0755 -d /etc/apt/keyrings
    # Always download to a temp file first: a truncated key left behind by an
    # interrupted run must not poison every later re-run.
    if curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc.tmp; then
      mv /etc/apt/keyrings/docker.asc.tmp /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    elif [ -s /etc/apt/keyrings/docker.asc ]; then
      log_warn "Could not refresh the Docker GPG key - reusing the existing one."
    else
      log_error "Failed to download the Docker GPG key. Check the network connection and re-run."
      exit 1
    fi
    local codename arch
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
    if [ -z "$codename" ]; then
      codename="$(lsb_release -cs)"
    fi
    arch="$(dpkg --print-architecture)"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$arch" "$codename" > /etc/apt/sources.list.d/docker.list
    apt_get update -y -q
    apt_get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    log_success "Docker Engine installed."
  fi

  if has_command systemctl; then
    systemctl enable docker >/dev/null 2>&1 || true
    systemctl start docker >/dev/null 2>&1 || true
  fi

  if ! docker info >/dev/null 2>&1; then
    log_error "The Docker daemon is not running and could not be started."
    log_error "Start it manually (systemctl start docker) and re-run the installer."
    exit 1
  fi
}

# Standalone docker-compose binaries are only usable when they are v2+;
# the legacy python docker-compose 1.x cannot parse this project's compose
# file (versionless Compose spec with a top-level "name:").
docker_compose_binary_is_v2() {
  has_command docker-compose &&
    docker-compose version --short 2>/dev/null | grep -qE '^v?2'
}

install_compose() {
  if docker compose version >/dev/null 2>&1; then
    log_info "Docker Compose plugin already installed: $(docker compose version --short 2>/dev/null || echo 'unknown version')"
    return 0
  fi
  if docker_compose_binary_is_v2; then
    log_info "Found standalone Docker Compose v2 binary: $(docker-compose version --short 2>/dev/null || echo 'unknown version')"
    return 0
  fi
  if has_command docker-compose; then
    log_warn "Found a legacy docker-compose v1 binary - it cannot run this project; installing the v2 plugin."
  fi
  log_info "Installing the Docker Compose plugin ..."
  if ! apt_get install -y -q docker-compose-plugin; then
    apt_get install -y -q docker-compose-v2
  fi
  if ! docker compose version >/dev/null 2>&1; then
    log_error "Failed to install the Docker Compose plugin."
    exit 1
  fi
  log_success "Docker Compose plugin installed."
}

COMPOSE_CMD=()

detect_compose_command() {
  if [ "${#COMPOSE_CMD[@]}" -gt 0 ]; then
    return 0
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD=(docker compose)
  elif docker_compose_binary_is_v2; then
    COMPOSE_CMD=(docker-compose)
  else
    log_error "Docker Compose v2 is not available."
    return 1
  fi
}

create_directories() {
  log_info "Creating ZED_BOT directories under ${ZEDBOT_BASE_DIR} ..."
  mkdir -p "$ZEDBOT_BASE_DIR" "$APP_DIR" "$DATA_DIR" "$HOST_BACKUP_DIR" "$LOGS_DIR"
  mkdir -p "${DATA_DIR}/postgres" "${DATA_DIR}/redis"
  chmod 700 "$DATA_DIR"
  # The backup dir is bind-mounted into the bot (read-only) and worker
  # (read-write) containers, which run as the unprivileged runtime user -
  # hand it over (750: owner + group only, never world accessible).
  # Idempotent: safe on every re-run, never deletes anything.
  chown "${RUNTIME_UID}:${RUNTIME_GID}" "$HOST_BACKUP_DIR"
  chmod 750 "$HOST_BACKUP_DIR"
  log_success "Directories ready: ${APP_DIR}, ${DATA_DIR}, ${HOST_BACKUP_DIR}, ${LOGS_DIR}"
}

ensure_git_safe_directory() {
  # --add appends duplicates on every run; only add when missing.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR"; then
    git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true
  fi
}

clone_or_update_repo() {
  if [ -d "${APP_DIR}/.git" ]; then
    log_info "Repository already present in ${APP_DIR} - fetching updates ..."
    ensure_git_safe_directory
    git -C "$APP_DIR" fetch --all --prune
    # Only switch branches when one was explicitly requested via ZEDBOT_BRANCH;
    # otherwise respect whatever the server is already tracking.
    if [ -n "${ZEDBOT_BRANCH:-}" ]; then
      local current_branch
      current_branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
      if [ "$current_branch" != "$REPO_BRANCH" ]; then
        log_info "Switching from branch '${current_branch}' to '${REPO_BRANCH}' ..."
        git -C "$APP_DIR" checkout "$REPO_BRANCH" ||
          log_warn "Could not switch to '${REPO_BRANCH}'; staying on '${current_branch}'."
      fi
    fi
    if ! git -C "$APP_DIR" pull --ff-only; then
      log_warn "Could not fast-forward the repository (local changes?). Continuing with the current code."
    fi
  elif [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    log_error "${APP_DIR} exists but is not a git repository."
    log_error "Move it away (or delete it) and re-run the installer."
    exit 1
  else
    log_info "Cloning ${REPO_URL} (branch: ${REPO_BRANCH}) into ${APP_DIR} ..."
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    log_success "Repository cloned."
  fi
}

# Basic sanity check for a bare domain name (no scheme, at least one dot).
is_valid_domain() {
  printf '%s' "$1" | grep -Eq '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$'
}

prompt_domain() {
  local domain="${ZEDBOT_APP_DOMAIN:-}"
  domain="$(sanitize_value "$domain")"
  if ! can_prompt; then
    if is_valid_domain "$domain"; then
      printf '%s' "$domain"
      return 0
    fi
    log_error "ZED_BOT requires a domain name. Set ZEDBOT_APP_DOMAIN when installing non-interactively."
    exit 1
  fi
  while :; do
    domain="$(prompt_value "Domain name for this server (e.g. bot.example.com - IP addresses are not supported)" "$domain")"
    domain="$(sanitize_value "$domain")"
    if is_valid_domain "$domain"; then
      printf '%s' "$domain"
      return 0
    fi
    log_warn "'${domain}' is not a valid domain name. Enter a bare domain such as bot.example.com."
    domain=""
  done
}

create_env_file() {
  if [ -f "$ENV_FILE" ]; then
    log_info "An existing .env configuration was found."
    if confirm "Keep the existing .env configuration?" "y"; then
      chmod 600 "$ENV_FILE"
      log_success "Keeping the existing .env (permissions enforced to 600)."
      return 0
    fi
    local backup_env
    backup_env="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$ENV_FILE" "$backup_env"
    chmod 600 "$backup_env"
    log_info "The previous .env was saved to ${backup_env}."
  fi

  log_info "Creating a new .env configuration."
  log_info "Press ENTER to accept a default. Secret input is hidden and never printed."

  local telegram_token admin_ids app_domain ssl_email
  telegram_token="$(prompt_secret "Telegram bot token from @BotFather (can be added later)" "${ZEDBOT_TELEGRAM_BOT_TOKEN:-}")"
  admin_ids="$(prompt_value "Main admin Telegram numeric ID (more can be added comma-separated)" "${ZEDBOT_ADMIN_TELEGRAM_IDS:-}")"
  app_domain="$(prompt_domain)"
  ssl_email="$(prompt_value "Email for SSL certificates" "${ZEDBOT_SSL_EMAIL:-admin@${app_domain}}")"

  telegram_token="$(sanitize_value "$telegram_token")"
  admin_ids="$(sanitize_value "$admin_ids")"
  ssl_email="$(sanitize_value "$ssl_email")"
  if [ -z "$ssl_email" ]; then
    ssl_email="admin@${app_domain}"
  fi
  if [ -z "$telegram_token" ]; then
    log_warn "TELEGRAM_BOT_TOKEN is empty. Add it to ${ENV_FILE} before enabling real bot features."
  fi

  # All infrastructure secrets are generated - they never travel through a
  # prompt unless preseeded via ZEDBOT_* variables for automation.
  local postgres_password redis_password app_secret internal_api_token backup_encryption_password
  postgres_password="$(sanitize_value "${ZEDBOT_POSTGRES_PASSWORD:-}")"
  redis_password="$(sanitize_value "${ZEDBOT_REDIS_PASSWORD:-}")"
  if [ -z "$postgres_password" ]; then
    postgres_password="$(generate_password)"
    log_info "Generated a secure random PostgreSQL password."
  fi
  if [ -z "$redis_password" ]; then
    redis_password="$(generate_password)"
    log_info "Generated a secure random Redis password."
  fi
  app_secret="$(generate_password)"
  internal_api_token="$(generate_password)"
  backup_encryption_password="$(generate_password)"
  log_info "Generated APP_SECRET, INTERNAL_API_TOKEN and BACKUP_ENCRYPTION_PASSWORD."

  local database_url redis_url
  database_url="postgresql://zedbot:$(urlencode "$postgres_password")@postgres:5432/zedbot"
  redis_url="redis://:$(urlencode "$redis_password")@redis:6379/0"

  local old_umask
  old_umask="$(umask)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# ZED_BOT environment configuration
# Generated by install.sh on $(date -u +'%Y-%m-%d %H:%M:%S UTC')
# This file contains credentials - keep it secret (chmod 600).

# --- Application ---
NODE_ENV='production'
APP_NAME='ZED_BOT'
APP_DOMAIN='${app_domain}'
APP_BASE_URL='https://${app_domain}'
API_PORT='3000'
LOG_LEVEL='info'

# --- SSL (reverse proxy / certificates land in a later phase) ---
SSL_EMAIL='${ssl_email}'

# --- Telegram ---
TELEGRAM_BOT_TOKEN='${telegram_token}'
ADMIN_TELEGRAM_IDS='${admin_ids}'

# --- PostgreSQL ---
POSTGRES_DB='zedbot'
POSTGRES_USER='zedbot'
POSTGRES_PASSWORD='${postgres_password}'
DATABASE_URL='${database_url}'

# --- Redis ---
REDIS_HOST='redis'
REDIS_PORT='6379'
REDIS_PASSWORD='${redis_password}'
REDIS_URL='${redis_url}'

# --- Application secrets ---
APP_SECRET='${app_secret}'
INTERNAL_API_TOKEN='${internal_api_token}'

# --- Backups ---
# HOST directory holding all backups (bind-mounted into bot ro / worker rw).
ZEDBOT_BACKUP_DIR='${HOST_BACKUP_DIR}'
BACKUP_RETENTION_DAYS='14'
BACKUP_MIN_RETAINED='3'
# UID/GID of the container runtime user that owns ZEDBOT_BACKUP_DIR.
ZEDBOT_RUNTIME_UID='${RUNTIME_UID}'
ZEDBOT_RUNTIME_GID='${RUNTIME_GID}'
# NOTE: BACKUP_DIR (the IN-CONTAINER path) is intentionally NOT set here.
# docker-compose.yml pins it to /var/lib/zedbot/backups for bot and worker;
# setting a host path here would not relocate anything (use
# ZEDBOT_BACKUP_DIR above instead).
# When set, backups are encrypted (AES-256-GCM). Keep a copy of this password
# somewhere safe OUTSIDE this server - encrypted backups are useless without
# it. Empty value = unencrypted backups.
BACKUP_ENCRYPTION_PASSWORD='${backup_encryption_password}'

# --- Paths (used by docker-compose bind mounts) ---
ZEDBOT_DATA_DIR='${DATA_DIR}'
EOF
  umask "$old_umask"
  chmod 600 "$ENV_FILE"
  log_success ".env created at ${ENV_FILE} (permissions 600). Secrets were not printed."
  log_warn "Backups will be ENCRYPTED. Store a copy of BACKUP_ENCRYPTION_PASSWORD somewhere safe:"
  log_warn "  grep BACKUP_ENCRYPTION_PASSWORD ${ENV_FILE}"
}

install_cli() {
  log_info "Installing the zedbot CLI to ${CLI_PATH} ..."
  chmod +x "${APP_DIR}/scripts/"*.sh "${APP_DIR}/scripts/zedbot"
  # scripts/zedbot.sh is the canonical CLI; scripts/zedbot stays as a
  # compatibility wrapper for anything that still calls it directly.
  install -m 0755 "${APP_DIR}/scripts/zedbot.sh" "$CLI_PATH"
  log_success "zedbot CLI installed."
}

start_services() {
  detect_compose_command
  log_info "Building and starting services (the first build may take a few minutes) ..."
  ( cd "$APP_DIR" && "${COMPOSE_CMD[@]}" up -d --build --remove-orphans )
  log_success "Services started."
}

# PostgreSQL only reads POSTGRES_PASSWORD when the data directory is first
# initialized. When the installer re-runs and the user recreates .env (new or
# regenerated password), the persistent volume would keep the old password
# while every script and app uses the new one - so re-align it here. On a
# fresh install this is a no-op (same password). The password travels via
# stdin, never on a command line.
sync_postgres_password() {
  local pg_user pg_pass pw_sql waited=0
  pg_user="$( (. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${POSTGRES_USER:-zedbot}") 2>/dev/null || echo zedbot)"
  pg_pass="$( (. "$ENV_FILE" >/dev/null 2>&1; printf '%s' "${POSTGRES_PASSWORD:-}") 2>/dev/null || echo '')"
  if [ -z "$pg_pass" ]; then
    return 0
  fi
  until ( cd "$APP_DIR" && "${COMPOSE_CMD[@]}" exec -T postgres pg_isready -U "$pg_user" >/dev/null 2>&1 ); do
    waited=$((waited + 3))
    if [ "$waited" -ge 120 ]; then
      log_warn "postgres did not become ready in time - skipping the password synchronization."
      return 0
    fi
    sleep 3
  done
  pw_sql="${pg_pass//"'"/"''"}"
  if ( cd "$APP_DIR" && "${COMPOSE_CMD[@]}" exec -T postgres psql -q -U "$pg_user" -d postgres >/dev/null ) <<SQL
ALTER USER "${pg_user}" WITH PASSWORD '${pw_sql}';
SQL
  then
    log_info "PostgreSQL password verified against .env."
  else
    log_warn "Could not synchronize the PostgreSQL password with .env. Run 'zedbot doctor' to check the database."
  fi
}

run_migrations_if_available() {
  if [ -x "${APP_DIR}/scripts/migrate.sh" ]; then
    log_info "Running database migrations ..."
    if "${APP_DIR}/scripts/migrate.sh"; then
      log_success "Database migrations completed."
    else
      log_warn "Database migrations reported an error. Check 'zedbot logs' for details."
    fi
  else
    log_info "No migration command found - skipping (nothing to migrate yet)."
  fi
}

print_summary() {
  local domain port
  domain="$( (set -a && . "$ENV_FILE" >/dev/null 2>&1 && printf '%s' "${APP_DOMAIN:-localhost}") || echo localhost)"
  port="$( (set -a && . "$ENV_FILE" >/dev/null 2>&1 && printf '%s' "${API_PORT:-3000}") || echo 3000)"

  echo
  log_success "ZED_BOT installation finished."
  cat <<EOF

  Paths
    Application : ${APP_DIR}
    Data        : ${DATA_DIR}
    Backups     : ${HOST_BACKUP_DIR}
    Logs        : ${LOGS_DIR}
    Config      : ${ENV_FILE} (chmod 600)

  Public endpoint (after 'zedbot nginx' + 'zedbot ssl')
    https://${domain}/health
  Local API (loopback only)
    http://127.0.0.1:${port}/health

  Useful commands
    zedbot status     - show service status
    zedbot logs       - tail all logs (zedbot logs api|bot|worker)
    zedbot doctor     - run health checks
    zedbot backup     - create a verified database backup (zedbot-db-YYYYMMDD-HHMMSS.dump[.enc])
    zedbot env-check  - validate the .env configuration (never prints values)
    zedbot nginx      - set up the Nginx reverse proxy
    zedbot ssl        - request the Let's Encrypt certificate (HTTPS)
    zedbot firewall   - safe ufw setup (SSH stays allowed)
    zedbot security   - read-only security audit

EOF
}

# Safe firewall (Phase 38). Never enabled automatically and never fails the
# installation - the SSH rule is added before ufw can ever be enabled.
setup_firewall_if_requested() {
  local wanted=""
  if [ "${ZEDBOT_ENABLE_FIREWALL:-0}" = "1" ]; then
    wanted=1
  elif [ "${ZEDBOT_NONINTERACTIVE:-0}" = "1" ]; then
    wanted=""
  elif confirm "Configure safe firewall rules now (ufw: allow SSH/80/443, deny other incoming)?" "n"; then
    wanted=1
  fi
  if [ -z "$wanted" ]; then
    log_info "Skipping the firewall. Configure it later with: zedbot firewall (audit: zedbot security)"
    return 0
  fi
  if ! bash "${APP_DIR}/scripts/firewall-setup.sh"; then
    log_warn "Firewall setup failed. The app keeps running; retry later with: zedbot firewall"
  fi
  return 0
}

# Nginx + HTTPS (Phase 37). Never fails the installation: the app services
# are already running; a failed certificate request just prints how to
# finish later (typically once DNS points at this server).
setup_https_if_requested() {
  local wanted=""
  if [ "${ZEDBOT_SETUP_SSL:-0}" = "1" ]; then
    wanted=1
  elif [ "${ZEDBOT_NONINTERACTIVE:-0}" = "1" ]; then
    wanted=""
  elif confirm "Set up Nginx and HTTPS (Let's Encrypt) now?" "n"; then
    wanted=1
  fi
  if [ -z "$wanted" ]; then
    log_info "Skipping HTTPS setup. When the domain's DNS points at this server, run:"
    log_info "  zedbot nginx"
    log_info "  zedbot ssl"
    return 0
  fi
  if ! bash "${APP_DIR}/scripts/nginx-setup.sh"; then
    log_warn "Nginx setup failed. The app keeps running; retry later with: zedbot nginx"
    return 0
  fi
  if ! bash "${APP_DIR}/scripts/ssl-setup.sh"; then
    log_warn "Certificate setup failed (DNS not pointing here yet?)."
    log_warn "The app keeps running over HTTP; retry later with: zedbot ssl"
  fi
  return 0
}

main() {
  echo
  log_info "ZED_BOT installer starting ..."
  require_root
  require_ubuntu
  install_base_packages
  install_docker
  install_compose
  create_directories
  clone_or_update_repo
  create_env_file
  install_cli
  start_services
  sync_postgres_password
  run_migrations_if_available
  if [ -x "${APP_DIR}/scripts/doctor.sh" ]; then
    log_info "Running post-install health checks ..."
    bash "${APP_DIR}/scripts/doctor.sh" || log_warn "Doctor reported problems. Run 'zedbot doctor' for details."
  fi
  setup_https_if_requested
  setup_firewall_if_requested
  print_summary
}

main "$@"
