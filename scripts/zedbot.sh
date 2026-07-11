#!/usr/bin/env bash
# =============================================================================
# ZED_BOT server management CLI (canonical script).
# Installed to /usr/local/bin/zedbot by scripts/install.sh.
#
# Restore is INSTRUCTIONS ONLY: `zedbot restore` / `zedbot restore-help`
# print the manual steps and exit without touching anything. There is no
# uninstall command.
# =============================================================================

set -Eeuo pipefail

ZEDBOT_APP_DIR="${ZEDBOT_APP_DIR:-/opt/zedbot/app}"
SCRIPTS_DIR="${ZEDBOT_APP_DIR}/scripts"
COMMON_LIB="${SCRIPTS_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
ZED_BOT management CLI

Usage: zedbot <command> [arguments]

Commands:
  status                  Show the status of all services
  ps                      Alias of status (docker compose ps)
  logs [service]          Tail logs (all services, or one of: api, bot, worker, postgres, redis)
  restart                 Restart all services (re-reads .env)
  start                   Start all services
  stop                    Stop all services
  update                  Update ZED_BOT to the latest version (creates a safety backup first)
  backup                  Create a database backup (zedbot-db-YYYYMMDD-HHMMSS.sql.gz)
  health                  Quick health summary (services, database, disk)
  doctor                  Run the full system health checks
  shell [service]         Open a shell inside a container (default: bot)
  env-check               Validate the .env configuration (never prints values)
  nginx                   Set up / refresh the Nginx reverse proxy for APP_DOMAIN
  ssl                     Request the Let's Encrypt certificate and enable HTTPS
  renew-cert              Force a certificate renewal check and reload Nginx
  https-status            Show Nginx/certificate status and probe https://APP_DOMAIN/health
  firewall                Safe ufw setup (SSH is allowed BEFORE the firewall is enabled)
  security                Run the read-only security audit (alias: security-check)
  restore-help            Print MANUAL database restore instructions (nothing is executed)
  help                    Show this help

Examples:
  zedbot status
  zedbot logs api
  zedbot backup
  zedbot env-check
EOF
}

restore_help() {
  cat <<'EOF'
ZED_BOT manual database restore - INSTRUCTIONS ONLY
====================================================
This command executes NOTHING and changes NOTHING. Restore from Telegram or
from this CLI is intentionally not implemented; run the steps below manually
on the server.

  0. Take a FRESH backup first:
       zedbot backup

  1. Pick the backup file to restore (newest first):
       ls -1t /opt/zedbot/backups/zedbot-db-*.sql.gz

  2. Stop the application services (keep postgres running):
       cd /opt/zedbot/app
       docker compose stop api bot worker

  3. Restore the dump (values for <POSTGRES_USER> / <POSTGRES_DB> are in
     /opt/zedbot/app/.env - do not paste them into chats or logs):
       gunzip -c /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.sql.gz \
         | docker compose exec -T postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB>

  4. Start everything again and verify:
       docker compose up -d
       zedbot doctor
EOF
}

CMD="${1:-help}"
shift || true

# Print-only commands work everywhere, even before installation.
case "$CMD" in
  help | --help | -h)
    usage
    exit 0
    ;;
  restore | restore-help)
    restore_help
    exit 0
    ;;
esac

if [ ! -f "$COMMON_LIB" ]; then
  echo "[FAIL] ZED_BOT does not look installed (missing ${COMMON_LIB})." >&2
  echo "       Install it with:" >&2
  echo "       bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)" >&2
  exit 1
fi
# shellcheck source=lib/common.sh
. "$COMMON_LIB"

health_summary() {
  local backup_dir="${BACKUP_DIR:-$ZEDBOT_BACKUP_DIR}"
  log_info "Services:"
  run_compose ps || true
  if compose_service_running postgres; then
    if run_compose exec -T postgres pg_isready >/dev/null 2>&1; then
      log_success "Database: accepting connections."
    else
      log_error "Database: container is up but pg_isready failed."
    fi
  else
    log_error "Database: postgres container is not running."
  fi
  if [ -d "$backup_dir" ]; then
    log_info "Backup disk usage (${backup_dir}):"
    df -h "$backup_dir" | tail -n 1 || true
  else
    log_warn "Backup directory does not exist yet: ${backup_dir}"
  fi
}

case "$CMD" in
  status | ps)
    require_root
    app_cd
    detect_compose_command
    run_compose ps
    ;;
  logs)
    require_root
    app_cd
    detect_compose_command
    run_compose logs --tail=200 -f "$@"
    ;;
  restart)
    require_root
    app_cd
    detect_compose_command
    # `compose restart` never re-reads .env; recreating the containers does.
    run_compose up -d --force-recreate --remove-orphans
    log_success "All services restarted."
    ;;
  start)
    require_root
    app_cd
    detect_compose_command
    run_compose up -d
    log_success "All services started."
    ;;
  stop)
    require_root
    app_cd
    detect_compose_command
    run_compose stop
    log_success "All services stopped."
    ;;
  update)
    exec bash "${SCRIPTS_DIR}/update.sh" "$@"
    ;;
  backup)
    exec bash "${SCRIPTS_DIR}/backup-db.sh" "$@"
    ;;
  health)
    require_root
    app_cd
    detect_compose_command
    load_env_if_exists
    health_summary
    ;;
  doctor)
    exec bash "${SCRIPTS_DIR}/doctor.sh" "$@"
    ;;
  shell)
    require_root
    app_cd
    detect_compose_command
    SERVICE="${1:-bot}"
    run_compose exec "$SERVICE" bash 2>/dev/null || run_compose exec "$SERVICE" sh
    ;;
  env-check)
    exec bash "${SCRIPTS_DIR}/validate-env.sh" "$@"
    ;;
  nginx)
    exec bash "${SCRIPTS_DIR}/nginx-setup.sh" "$@"
    ;;
  ssl)
    exec bash "${SCRIPTS_DIR}/ssl-setup.sh" "$@"
    ;;
  renew-cert)
    exec bash "${SCRIPTS_DIR}/ssl-renew.sh" "$@"
    ;;
  firewall)
    exec bash "${SCRIPTS_DIR}/firewall-setup.sh" "$@"
    ;;
  security | security-check)
    exec bash "${SCRIPTS_DIR}/security-check.sh" "$@"
    ;;
  https-status)
    require_root
    load_env_if_exists
    if has_command nginx; then
      if has_command systemctl; then
        systemctl is-active nginx >/dev/null 2>&1 \
          && log_success "Nginx: active." \
          || log_error "Nginx: not active."
      fi
      nginx -t 2>&1 | tail -n 1 || true
    else
      log_warn "Nginx is not installed. Run: zedbot nginx"
    fi
    if has_command certbot; then
      certbot certificates 2>/dev/null || log_warn "No certificates found."
    else
      log_warn "certbot is not installed. Run: zedbot ssl"
    fi
    HTTPS_DOMAIN="$(printf '%s' "${APP_DOMAIN:-}" | tr '[:upper:]' '[:lower:]')"
    if is_valid_domain "$HTTPS_DOMAIN"; then
      log_info "Probing https://${HTTPS_DOMAIN}/health ..."
      curl -sSI --max-time 10 "https://${HTTPS_DOMAIN}/health" 2>&1 | head -n 1 \
        || log_warn "HTTPS probe failed (certificate missing or DNS not pointing here yet)."
    else
      log_warn "APP_DOMAIN is not set - skipping the HTTPS probe."
    fi
    ;;
  *)
    echo "[FAIL] Unknown command: ${CMD}" >&2
    echo
    usage
    exit 1
    ;;
esac
