#!/usr/bin/env bash
# =============================================================================
# ZED_BOT updater:
#   backup archive -> database backup + verification gate -> pull -> rebuild
#   -> restart -> migrate -> doctor
#
# The update ABORTS before touching any code when the pre-update database
# backup cannot be created AND verified - the running installation is left
# untouched. CLI-only escape hatch (use at your own risk):
#   ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot update
#
# Safe to run multiple times. Never prints secrets.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

on_update_error() {
  log_error "ZED_BOT update FAILED. Your data and .env were NOT deleted."
  log_error "Recovery steps:"
  log_error "  1. Inspect what went wrong:   zedbot logs        (or: zedbot doctor)"
  log_error "  2. Retry the update:          zedbot update"
  log_error "  3. If the app is broken, restore the pre-update backup MANUALLY:"
  log_error "       zedbot restore-help      (prints the manual restore steps)"
}
trap on_update_error ERR

# Finds the newest database backup file (any supported format) in the host
# backup directory. Prints its path; prints nothing when none exists.
newest_db_backup() {
  find "$ZEDBOT_BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' -o -name 'zedbot-db-*.sql.gz' \) \
    -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-
}

# Verifies one backup file; returns non-zero on any doubt.
verify_backup_file() {
  local file="$1"
  case "$file" in
    *.dump)
      # The postgres container's pg_restore must be able to read the
      # archive's table of contents (file travels over stdin).
      run_compose exec -T postgres pg_restore --list /dev/stdin < "$file" > /dev/null
      ;;
    *.dump.enc)
      # Full decryption checks need the worker's verify CLI; fall back to a
      # ZBK1 envelope header check when the CLI is not shipped yet.
      if run_compose run --rm --no-deps worker sh -c \
        'test -f apps/worker/dist/cli/verify-backup.js' >/dev/null 2>&1; then
        run_compose run --rm --no-deps worker node apps/worker/dist/cli/verify-backup.js \
          "/var/lib/zedbot/backups/${file##*/}"
      else
        log_warn "Worker verify CLI not available - checking the ZBK1 envelope header only."
        [ "$(head -c 4 "$file" 2>/dev/null)" = "ZBK1" ]
      fi
      ;;
    *.sql.gz)
      gzip -t "$file"
      ;;
    *)
      return 1
      ;;
  esac
}

pre_update_database_backup() {
  if [ "${ZEDBOT_SKIP_PREUPDATE_BACKUP:-0}" = "1" ]; then
    log_warn "ZEDBOT_SKIP_PREUPDATE_BACKUP=1 - SKIPPING the pre-update database backup gate."
    log_warn "If this update breaks the database there is no fresh backup to fall back to."
    return 0
  fi

  # Auto-repair for installations that predate the shared backup mount: the
  # directory must be owned by the container runtime user with mode 750.
  ensure_backup_dir_permissions

  if ! bash "${SCRIPT_DIR}/backup-db.sh"; then
    log_error "Pre-update database backup FAILED - ABORTING the update."
    log_error "The running installation was not modified."
    log_error "Fix the backup problem ('zedbot doctor', 'zedbot logs postgres') and retry,"
    log_error "or (NOT recommended) force past this gate with:"
    log_error "  ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot update"
    exit 1
  fi

  local newest
  newest="$(newest_db_backup)"
  if [ -z "$newest" ]; then
    log_error "No database backup found after a successful backup run - ABORTING the update."
    exit 1
  fi
  log_info "Verifying the pre-update backup ${newest##*/} ..."
  if ! verify_backup_file "$newest"; then
    log_error "Pre-update backup verification FAILED (${newest##*/}) - ABORTING the update."
    log_error "The running installation was not modified."
    exit 1
  fi
  log_success "Pre-update database backup verified: ${newest##*/}"
}

main() {
  require_root
  app_cd
  load_env_if_exists
  detect_compose_command

  log_info "Starting ZED_BOT update ..."

  log_info "[1/7] Creating a safety archive (.env + database) before updating ..."
  bash "${SCRIPT_DIR}/backup.sh"

  log_info "[2/7] Creating and verifying a database backup (update gate) ..."
  pre_update_database_backup

  log_info "[3/7] Pulling the latest code ..."
  # --add appends duplicates on every run; only add when missing.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$ZEDBOT_APP_DIR"; then
    git config --global --add safe.directory "$ZEDBOT_APP_DIR" >/dev/null 2>&1 || true
  fi
  git fetch --all --prune
  if ! git pull --ff-only; then
    log_warn "Could not fast-forward the repository (local modifications?). Continuing with the current code."
  fi

  log_info "[4/7] Building updated images ..."
  run_compose build

  log_info "[5/7] Restarting services ..."
  run_compose up -d --remove-orphans

  log_info "[6/7] Checking for database migrations ..."
  run_migrations_if_available

  log_info "[7/7] Running health checks ..."
  if bash "${SCRIPT_DIR}/doctor.sh"; then
    log_success "ZED_BOT update completed successfully."
  else
    log_warn "Update finished, but the doctor reported problems. Run 'zedbot doctor' for details."
  fi
}

main "$@"
