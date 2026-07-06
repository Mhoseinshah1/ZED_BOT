#!/usr/bin/env bash
# =============================================================================
# ZED_BOT doctor: prints a pass/fail table of system health checks.
#
# Exit code: 1 only when the CORE system is broken (Docker/Compose/app files
# missing); optional runtime checks report WARN without failing hard.
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

check_compose_available() {
  docker compose version >/dev/null 2>&1 || docker_compose_binary_is_v2
}

check_any_container_running() {
  compose_service_running api || compose_service_running bot || compose_service_running worker ||
    compose_service_running postgres || compose_service_running redis
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

main() {
  require_root
  load_env_if_exists

  echo
  log_info "ZED_BOT doctor - system health check"
  echo
  printf '  %-6s %s\n' "STATUS" "CHECK"
  printf '  %-6s %s\n' "------" "-----------------------------------------"

  # Core system
  optional_check "OS is Ubuntu" "only Ubuntu 22.04/24.04 are supported" check_ubuntu
  core_check "Docker installed" has_command docker
  core_check "Docker daemon running" docker info
  core_check "Docker Compose available" check_compose_available
  core_check "App directory exists (${ZEDBOT_APP_DIR})" test -d "$ZEDBOT_APP_DIR"
  core_check "docker-compose.yml exists" test -f "${ZEDBOT_APP_DIR}/docker-compose.yml"
  optional_check ".env exists" "run the installer to create it" test -f "$ZEDBOT_ENV_FILE"

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
      optional_check "API health endpoint responds" "zedbot logs api" check_api_health
    else
      skip_check "API health endpoint responds" "api container not running"
    fi
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

main "$@"
