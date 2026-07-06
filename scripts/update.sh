#!/usr/bin/env bash
# =============================================================================
# ZED_BOT updater: backup -> pull -> rebuild -> restart -> migrate -> doctor
# Safe to run multiple times. Never prints secrets.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

trap 'log_error "ZED_BOT update FAILED. Your data was not deleted; a pre-update backup is in ${ZEDBOT_BACKUP_DIR}."' ERR

main() {
  require_root
  app_cd
  detect_compose_command

  log_info "Starting ZED_BOT update ..."

  log_info "[1/6] Creating a safety backup before updating ..."
  bash "${SCRIPT_DIR}/backup.sh"

  log_info "[2/6] Pulling the latest code ..."
  git config --global --add safe.directory "$ZEDBOT_APP_DIR" >/dev/null 2>&1 || true
  git fetch --all --prune
  if ! git pull --ff-only; then
    log_warn "Could not fast-forward the repository (local modifications?). Continuing with the current code."
  fi

  log_info "[3/6] Building updated images ..."
  run_compose build

  log_info "[4/6] Restarting services ..."
  run_compose up -d --remove-orphans

  log_info "[5/6] Checking for database migrations ..."
  run_migrations_if_available

  log_info "[6/6] Running health checks ..."
  if bash "${SCRIPT_DIR}/doctor.sh"; then
    log_success "ZED_BOT update completed successfully."
  else
    log_warn "Update finished, but the doctor reported problems. Run 'zedbot doctor' for details."
  fi
}

main "$@"
