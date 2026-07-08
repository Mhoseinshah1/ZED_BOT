#!/usr/bin/env bash
# =============================================================================
# ZED_BOT uninstaller.
#
# Stops the services and removes the CLI. Data, backups and the application
# code are only deleted when explicitly confirmed - backups are kept by
# default.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root

  echo
  log_warn "This will stop all ZED_BOT services and remove the zedbot CLI from this server."
  if ! confirm "Continue with the uninstall?" "n"; then
    log_info "Uninstall cancelled. Nothing was changed."
    exit 0
  fi

  # Work from a directory that will survive any deletions below.
  cd /

  # 1. Stop and remove containers
  if [ -f "${ZEDBOT_APP_DIR}/docker-compose.yml" ] && has_command docker; then
    if detect_compose_command; then
      log_info "Stopping and removing containers ..."
      run_compose down --remove-orphans || log_warn "Could not stop the compose services (already stopped?)."
    fi
  else
    log_info "No docker-compose.yml found - skipping the service shutdown."
  fi

  local data_state="kept" backups_state="kept" app_state="kept"

  # 2. Application data (destructive, default: keep)
  if [ -d "$ZEDBOT_DATA_DIR" ] || [ -d "$ZEDBOT_LOGS_DIR" ]; then
    if confirm "Delete ALL application data in ${ZEDBOT_DATA_DIR} (PostgreSQL + Redis) and logs in ${ZEDBOT_LOGS_DIR}? This cannot be undone." "n"; then
      rm -rf "$ZEDBOT_DATA_DIR" "$ZEDBOT_LOGS_DIR"
      data_state="deleted"
      log_success "Data and logs directories deleted."
    else
      log_info "Keeping the data directory: ${ZEDBOT_DATA_DIR}"
    fi
  else
    data_state="not present"
  fi

  # 3. Backups (destructive, default: keep)
  if [ -d "$ZEDBOT_BACKUP_DIR" ]; then
    if confirm "Delete all backups in ${ZEDBOT_BACKUP_DIR}? This cannot be undone." "n"; then
      rm -rf "$ZEDBOT_BACKUP_DIR"
      backups_state="deleted"
      log_success "Backups deleted."
    else
      log_info "Keeping the backups: ${ZEDBOT_BACKUP_DIR}"
    fi
  else
    backups_state="not present"
  fi

  # 4. Application code (contains .env - default: keep)
  if [ -d "$ZEDBOT_APP_DIR" ]; then
    log_warn "Note: ${ZEDBOT_APP_DIR} contains your .env configuration (credentials)."
    if confirm "Delete the application code and .env in ${ZEDBOT_APP_DIR}?" "n"; then
      rm -rf "$ZEDBOT_APP_DIR"
      app_state="deleted"
      log_success "Application directory deleted."
    else
      log_info "Keeping the application directory: ${ZEDBOT_APP_DIR}"
    fi
  else
    app_state="not present"
  fi

  # 5. CLI
  if [ -e "$ZEDBOT_CLI_PATH" ]; then
    rm -f "$ZEDBOT_CLI_PATH"
    log_success "Removed ${ZEDBOT_CLI_PATH}."
  fi

  # Remove the base directory only when nothing is left inside it.
  rmdir "$ZEDBOT_BASE_DIR" >/dev/null 2>&1 || true

  echo
  log_info "Uninstall summary:"
  log_info "  Services  : stopped/removed"
  log_info "  CLI       : removed (${ZEDBOT_CLI_PATH})"
  log_info "  Data      : ${data_state} (${ZEDBOT_DATA_DIR})"
  log_info "  Backups   : ${backups_state} (${ZEDBOT_BACKUP_DIR})"
  log_info "  App code  : ${app_state} (${ZEDBOT_APP_DIR})"
  echo
  log_success "ZED_BOT uninstall finished."
}

main "$@"
