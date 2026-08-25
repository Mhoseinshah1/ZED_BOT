#!/usr/bin/env bash
# =============================================================================
# ZED_BOT security audit (used by `zedbot security` / `zedbot security-check`).
#
# READ-ONLY: prints a PASS/WARN/FAIL table and never changes anything or
# prints a secret value. Runs without root (root-only checks degrade to
# WARN/skip). Exits non-zero ONLY for the serious failures:
#   - .env group/world readable
#   - PostgreSQL or Redis published on a host port
#   - the API published on a non-loopback host port
#
# Test overrides: ZEDBOT_ENV_FILE and ZEDBOT_COMPOSE_FILE point the checks at
# arbitrary files.
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# Captured before sourcing common.sh: its reset_compose_fixed_identity()
# unconditionally pins ZEDBOT_ENV_FILE to the canonical production path (an
# anti-path-substitution guard for the MUTATING deployment scripts), which
# would otherwise silently discard the caller's override below - this
# READ-ONLY audit is the one place that deliberately still supports pointing
# itself at another file for testing.
TEST_ENV_FILE_OVERRIDE="${ZEDBOT_ENV_FILE:-}"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"
set +e # collect results; never abort mid-audit

COMPOSE_FILE="${ZEDBOT_COMPOSE_FILE:-${ZEDBOT_APP_DIR}/docker-compose.yml}"
ENV_FILE="${TEST_ENV_FILE_OVERRIDE:-$ZEDBOT_ENV_FILE}"

SERIOUS_FAILURES=0

pass() { printf '  [PASS] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
fail() {
  printf '  [FAIL] %s\n' "$1"
  if [ "${2:-}" = "serious" ]; then
    SERIOUS_FAILURES=$((SERIOUS_FAILURES + 1))
  fi
}

# KEY= value from the env file, parsed (never sourced), never printed.
env_value() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1)"
  [ -z "$line" ] && return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# The `ports:` lines of one compose service (top-level 2-space indentation).
service_ports() {
  local service="$1"
  awk -v svc="  ${service}:" '
    $0 == svc { inside = 1; next }
    inside && /^  [a-zA-Z]/ { inside = 0 }
    inside { print }
  ' "$COMPOSE_FILE" | awk '
    /^[[:space:]]+ports:/ { inports = 1; next }
    inports && /^[[:space:]]+-/ { print; next }
    inports && !/^[[:space:]]*#/ { inports = 0 }
  '
}

echo "ZED_BOT security check"
echo "  env file    : ${ENV_FILE}"
echo "  compose file: ${COMPOSE_FILE}"
echo

# --- 1+2: .env exists with 600-or-stricter permissions ------------------------
if [ ! -f "$ENV_FILE" ]; then
  warn ".env file not found (${ENV_FILE}) - run the installer first."
else
  perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '')"
  if [ -z "$perms" ]; then
    warn ".env permissions could not be read."
  elif [ $(( 0$perms & 077 )) -eq 0 ]; then
    pass ".env permissions are ${perms} (owner-only)."
  else
    fail ".env is group/world readable (${perms}) - run: chmod 600 ${ENV_FILE}" serious
  fi
fi

# --- 3: compose file exists ----------------------------------------------------
if [ ! -f "$COMPOSE_FILE" ]; then
  warn "docker-compose.yml not found (${COMPOSE_FILE}) - the remaining compose checks are skipped."
else
  # --- 4+5: postgres/redis must publish NO host ports --------------------------
  for svc in postgres redis; do
    svc_ports="$(service_ports "$svc")"
    if [ -z "$svc_ports" ]; then
      pass "${svc}: no host ports published."
    else
      fail "${svc}: publishes host ports - remove its ports: section." serious
    fi
  done

  # --- 6: the API binding must be loopback-only --------------------------------
  api_ports="$(service_ports api)"
  if [ -z "$api_ports" ]; then
    pass "api: no host ports published (nginx reaches it via the Docker network)."
  elif printf '%s' "$api_ports" | grep -q '127\.0\.0\.1:'; then
    pass "api: bound to 127.0.0.1 only."
  else
    fail "api: published on a public interface - bind it to 127.0.0.1 (see docker-compose.yml)." serious
  fi

  # --- 12: restart policy -------------------------------------------------------
  restart_count="$(grep -c 'restart: unless-stopped' "$COMPOSE_FILE" 2>/dev/null || echo 0)"
  # Count 2-space keys inside the services: block only (networks/volumes
  # definitions share the indentation but are not services).
  service_count="$(awk '
    /^services:/ { inside = 1; next }
    inside && /^[a-zA-Z]/ { inside = 0 }
    inside && /^  [a-zA-Z][a-zA-Z0-9_-]*:/ { count++ }
    END { print count + 0 }
  ' "$COMPOSE_FILE" 2>/dev/null)"
  if [ "$restart_count" -ge "$service_count" ] && [ "$service_count" -gt 0 ]; then
    pass "all ${service_count} services use restart: unless-stopped."
  else
    warn "only ${restart_count}/${service_count} services use restart: unless-stopped."
  fi

  # hardening flags (informational)
  if grep -q 'no-new-privileges:true' "$COMPOSE_FILE"; then
    pass "app services run with no-new-privileges."
  else
    warn "no-new-privileges is not set for the app services."
  fi
fi

# --- 7+8: nginx site + security headers -----------------------------------------
APP_DOMAIN_VALUE="$(env_value APP_DOMAIN 2>/dev/null | tr '[:upper:]' '[:lower:]')"
NGINX_SITE="${ZEDBOT_NGINX_SITE_AVAILABLE}"
if [ -z "$APP_DOMAIN_VALUE" ]; then
  warn "APP_DOMAIN is not set - nginx checks skipped."
elif [ ! -f "$NGINX_SITE" ]; then
  warn "nginx site not found (${NGINX_SITE}) - run: zedbot nginx"
else
  pass "nginx site exists (${NGINX_SITE})."
  if [ -f "/etc/letsencrypt/live/${APP_DOMAIN_VALUE}/fullchain.pem" ]; then
    headers_missing=""
    for header in "X-Content-Type-Options" "X-Frame-Options" "Referrer-Policy" "Strict-Transport-Security"; do
      grep -q "$header" "$NGINX_SITE" || headers_missing="${headers_missing} ${header}"
    done
    if [ -z "$headers_missing" ]; then
      pass "nginx HTTPS config carries all security headers."
    else
      fail "nginx HTTPS config is missing:${headers_missing} - re-run: zedbot ssl"
    fi
    if grep -q 'server_tokens off' "$NGINX_SITE"; then
      pass "nginx hides its version (server_tokens off)."
    else
      warn "server_tokens off is missing - re-run: zedbot nginx"
    fi
  else
    warn "no certificate yet for ${APP_DOMAIN_VALUE} - run: zedbot ssl (headers are checked after HTTPS)."
  fi
fi

# --- 9: backup dir permissions ----------------------------------------------------
# ZEDBOT_BACKUP_DIR is the HOST path (BACKUP_DIR in .env is the in-container
# mount path since the ops phase and never points at a host directory).
BACKUP_DIR_VALUE="$(env_value ZEDBOT_BACKUP_DIR 2>/dev/null)"
BACKUP_DIR_VALUE="${BACKUP_DIR_VALUE:-$ZEDBOT_BACKUP_DIR}"
if [ -d "$BACKUP_DIR_VALUE" ]; then
  bperms="$(stat -c '%a' "$BACKUP_DIR_VALUE" 2>/dev/null || echo '')"
  if [ -n "$bperms" ] && [ $(( 0$bperms & 007 )) -eq 0 ]; then
    pass "backup directory is not world accessible (${bperms})."
  else
    warn "backup directory permissions are ${bperms:-unknown} - repair with: zedbot repair backups"
  fi
else
  warn "backup directory does not exist yet (${BACKUP_DIR_VALUE})."
fi

# --- 10: management scripts present ------------------------------------------------
missing_scripts=""
for script in zedbot.sh validate-env.sh backup-db.sh nginx-setup.sh ssl-setup.sh firewall-setup.sh; do
  [ -f "${SCRIPT_DIR}/${script}" ] || missing_scripts="${missing_scripts} ${script}"
done
if [ -z "$missing_scripts" ]; then
  pass "all management scripts are present."
else
  warn "missing scripts:${missing_scripts}"
fi

# --- 11: no credential-bearing URLs in docs/README (light scan) --------------------
# Only real-looking passwords count (8+ credential chars) - documentation
# placeholders like `…`, `pw` or `<password>` are fine.
REPO_DIR="${ZEDBOT_APP_DIR}"
if [ -d "${REPO_DIR}/docs" ] || [ -f "${REPO_DIR}/README.md" ]; then
  if grep -rlE 'postgres(ql)?://[^:@/]+:[A-Za-z0-9_-]{8,}@' "${REPO_DIR}/docs" "${REPO_DIR}/README.md" "${REPO_DIR}/.env.example" 2>/dev/null | head -n 3 | grep -q .; then
    warn "a credential-looking database URL appears in docs/README/.env.example - review those files."
  else
    pass "no credential-bearing database URLs in docs/README/.env.example."
  fi
fi

# --- firewall state (informational) --------------------------------------------------
if has_command ufw; then
  if [ "$(id -u)" -eq 0 ]; then
    if ufw status 2>/dev/null | grep -q '^Status: active'; then
      pass "ufw is active."
    else
      warn "ufw is installed but not active - run: zedbot firewall"
    fi
  else
    warn "not running as root - ufw state not checked."
  fi
else
  warn "ufw is not installed - run: zedbot firewall"
fi

# --- container restart policy at runtime (root+docker only) ---------------------------
if [ "$(id -u)" -eq 0 ] && check_docker 2>/dev/null; then
  bad_policy="$(docker ps --filter name=zedbot- --format '{{.Names}}' 2>/dev/null | while read -r name; do
    policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null)"
    [ "$policy" = "unless-stopped" ] || printf '%s ' "$name"
  done)"
  if [ -z "$bad_policy" ]; then
    pass "running containers use restart: unless-stopped."
  else
    warn "containers without unless-stopped: ${bad_policy}"
  fi
fi

echo
if [ "$SERIOUS_FAILURES" -gt 0 ]; then
  echo "[FAIL] security check found ${SERIOUS_FAILURES} serious problem(s) - fix them as soon as possible."
  exit 1
fi
echo "[ OK ] security check found no serious problems."
exit 0
