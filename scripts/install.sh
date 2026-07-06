#!/usr/bin/env bash
# =============================================================================
# ZED_BOT installer for Ubuntu 22.04 / 24.04
#
# Usage (as root):
#   bash <(curl -Ls https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)
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
#   ZEDBOT_APP_DOMAIN_OR_IP       preseed APP_DOMAIN_OR_IP
#   ZEDBOT_POSTGRES_PASSWORD      preseed POSTGRES_PASSWORD
#   ZEDBOT_REDIS_PASSWORD         preseed REDIS_PASSWORD
# =============================================================================

set -Eeuo pipefail

# --- Configuration -----------------------------------------------------------
ZEDBOT_BASE_DIR="${ZEDBOT_BASE_DIR:-/opt/zedbot}"
APP_DIR="${ZEDBOT_APP_DIR:-${ZEDBOT_BASE_DIR}/app}"
DATA_DIR="${ZEDBOT_DATA_DIR:-${ZEDBOT_BASE_DIR}/data}"
BACKUP_DIR="${ZEDBOT_BACKUP_DIR:-${ZEDBOT_BASE_DIR}/backups}"
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
    log_error "Cannot detect the operating system. ZED_BOT supports Ubuntu 22.04 and 24.04."
    exit 1
  fi
  os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  os_pretty="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  if [ "$os_id" != "ubuntu" ]; then
    log_error "Unsupported OS: ${os_pretty}. ZED_BOT supports Ubuntu 22.04 and 24.04."
    exit 1
  fi
  case "$os_version" in
    22.04 | 24.04)
      log_info "Detected supported OS: ${os_pretty}"
      ;;
    *)
      log_warn "Detected ${os_pretty}. Officially supported: Ubuntu 22.04 / 24.04. Continuing anyway."
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

# Strips characters that would break .env parsing (quotes, CR/LF). The values
# collected here (tokens, ids, hostnames, passwords) never legitimately
# contain them.
sanitize_value() {
  printf '%s' "$1" | tr -d "\r\n'\""
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
install_base_packages() {
  log_info "Installing base packages (curl, git, ca-certificates, gnupg, lsb-release, openssl) ..."
  apt-get update -y -q
  apt-get install -y -q curl git ca-certificates gnupg lsb-release openssl
  log_success "Base packages installed."
}

install_docker() {
  if has_command docker; then
    log_info "Docker is already installed: $(docker --version 2>/dev/null || echo 'unknown version')"
  else
    log_info "Installing Docker Engine from the official Docker repository ..."
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.asc ]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    fi
    local codename arch
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
    if [ -z "$codename" ]; then
      codename="$(lsb_release -cs)"
    fi
    arch="$(dpkg --print-architecture)"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$arch" "$codename" > /etc/apt/sources.list.d/docker.list
    apt-get update -y -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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

install_compose() {
  if docker compose version >/dev/null 2>&1; then
    log_info "Docker Compose plugin already installed: $(docker compose version --short 2>/dev/null || echo 'unknown version')"
    return 0
  fi
  if has_command docker-compose; then
    log_info "Found legacy docker-compose binary: $(docker-compose --version 2>/dev/null || echo 'unknown version')"
    return 0
  fi
  log_info "Installing the Docker Compose plugin ..."
  if ! apt-get install -y -q docker-compose-plugin; then
    apt-get install -y -q docker-compose-v2
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
  elif has_command docker-compose; then
    COMPOSE_CMD=(docker-compose)
  else
    log_error "Docker Compose is not available."
    return 1
  fi
}

create_directories() {
  log_info "Creating ZED_BOT directories under ${ZEDBOT_BASE_DIR} ..."
  mkdir -p "$ZEDBOT_BASE_DIR" "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
  mkdir -p "${DATA_DIR}/postgres" "${DATA_DIR}/redis"
  chmod 700 "$DATA_DIR" "$BACKUP_DIR"
  log_success "Directories ready: ${APP_DIR}, ${DATA_DIR}, ${BACKUP_DIR}"
}

clone_or_update_repo() {
  if [ -d "${APP_DIR}/.git" ]; then
    log_info "Repository already present in ${APP_DIR} - fetching updates ..."
    git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true
    git -C "$APP_DIR" fetch --all --prune
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

  local telegram_token admin_ids app_domain postgres_password redis_password default_ip
  telegram_token="$(prompt_secret "Telegram bot token from @BotFather (can be added later)" "${ZEDBOT_TELEGRAM_BOT_TOKEN:-}")"
  admin_ids="$(prompt_value "Admin Telegram user IDs (comma separated)" "${ZEDBOT_ADMIN_TELEGRAM_IDS:-}")"
  default_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  app_domain="$(prompt_value "Server domain or public IP" "${ZEDBOT_APP_DOMAIN_OR_IP:-${default_ip:-127.0.0.1}}")"
  postgres_password="$(prompt_secret "PostgreSQL password (leave empty to auto-generate)" "${ZEDBOT_POSTGRES_PASSWORD:-}")"
  redis_password="$(prompt_secret "Redis password (leave empty to auto-generate)" "${ZEDBOT_REDIS_PASSWORD:-}")"

  telegram_token="$(sanitize_value "$telegram_token")"
  admin_ids="$(sanitize_value "$admin_ids")"
  app_domain="$(sanitize_value "$app_domain")"
  postgres_password="$(sanitize_value "$postgres_password")"
  redis_password="$(sanitize_value "$redis_password")"

  if [ -z "$postgres_password" ]; then
    postgres_password="$(generate_password)"
    log_info "Generated a secure random PostgreSQL password."
  fi
  if [ -z "$redis_password" ]; then
    redis_password="$(generate_password)"
    log_info "Generated a secure random Redis password."
  fi
  if [ -z "$telegram_token" ]; then
    log_warn "TELEGRAM_BOT_TOKEN is empty. Add it to ${ENV_FILE} before enabling real bot features."
  fi

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
APP_DOMAIN_OR_IP='${app_domain}'
API_PORT='3000'

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

# --- Paths (used by docker-compose bind mounts) ---
ZEDBOT_DATA_DIR='${DATA_DIR}'
EOF
  umask "$old_umask"
  chmod 600 "$ENV_FILE"
  log_success ".env created at ${ENV_FILE} (permissions 600). Secrets were not printed."
}

install_cli() {
  log_info "Installing the zedbot CLI to ${CLI_PATH} ..."
  chmod +x "${APP_DIR}/scripts/"*.sh "${APP_DIR}/scripts/zedbot"
  install -m 0755 "${APP_DIR}/scripts/zedbot" "$CLI_PATH"
  log_success "zedbot CLI installed."
}

start_services() {
  detect_compose_command
  log_info "Building and starting services (the first build may take a few minutes) ..."
  ( cd "$APP_DIR" && "${COMPOSE_CMD[@]}" up -d --build --remove-orphans )
  log_success "Services started."
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
  domain="$( (set -a && . "$ENV_FILE" >/dev/null 2>&1 && printf '%s' "${APP_DOMAIN_OR_IP:-127.0.0.1}") || echo 127.0.0.1)"
  port="$( (set -a && . "$ENV_FILE" >/dev/null 2>&1 && printf '%s' "${API_PORT:-3000}") || echo 3000)"

  echo
  log_success "ZED_BOT installation finished."
  cat <<EOF

  Paths
    Application : ${APP_DIR}
    Data        : ${DATA_DIR}
    Backups     : ${BACKUP_DIR}
    Config      : ${ENV_FILE} (chmod 600)

  API health check
    http://${domain}:${port}/health

  Useful commands
    zedbot status    - show service status
    zedbot doctor    - run health checks
    zedbot logs      - tail all logs (zedbot logs api|bot|worker)
    zedbot update    - update to the latest version
    zedbot backup    - create a backup

EOF
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
  run_migrations_if_available
  if [ -x "${APP_DIR}/scripts/doctor.sh" ]; then
    log_info "Running post-install health checks ..."
    bash "${APP_DIR}/scripts/doctor.sh" || log_warn "Doctor reported problems. Run 'zedbot doctor' for details."
  fi
  print_summary
}

main "$@"
