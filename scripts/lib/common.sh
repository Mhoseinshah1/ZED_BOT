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

# Strip leading/trailing shell whitespace (space, tab, CR, newline) from a value
# WITHOUT eval, without logging/printing it to output, and without exposing its
# length or touching interior characters. Mirrors the runtime resolver's
# value.trim() (packages/shared/src/telegram-token.ts) so a whitespace-only token
# reads as unset in exactly the same way. Returns the trimmed value via stdout
# (captured with $(...), like the other value helpers) - never echoed to a log.
# The dependency-free scripts/validate-env.sh keeps a behaviourally identical
# inline copy; keep the two in sync.
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

# --- Deployment identity / legacy self-heal ----------------------------------
# Helpers for the self-healing update flow: installations that predate the
# persistent-backup layout (PR #92) keep an old installed CLI, an old .env
# and stale containers after `zedbot update`. These helpers converge them.
# All idempotent; none ever prints a secret.

# Prints the repository HEAD SHA; prints nothing (and still returns 0) when
# it cannot be determined. Registers safe.directory first the way update.sh
# does - root-invoked git refuses user-owned checkouts otherwise.
repo_head_sha() {
  # --add appends duplicates on every run; only add when missing.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$ZEDBOT_APP_DIR"; then
    git config --global --add safe.directory "$ZEDBOT_APP_DIR" >/dev/null 2>&1 || true
  fi
  git -C "$ZEDBOT_APP_DIR" rev-parse HEAD 2>/dev/null || true
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
  local sha
  sha="$(repo_head_sha)"
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
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
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
