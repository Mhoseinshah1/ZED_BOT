#!/usr/bin/env bash
# =============================================================================
# ZED_BOT restore: restores .env and the PostgreSQL database from a backup
# archive created by backup.sh.
#
# Usage: zedbot restore <backup-file>
#        (bare file names are resolved inside /opt/zedbot/backups)
#
# Restore is DESTRUCTIVE and asks for confirmation first.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

RESTORE_TMP_DIR=""

cleanup() {
  if [ -n "$RESTORE_TMP_DIR" ] && [ -d "$RESTORE_TMP_DIR" ]; then
    rm -rf "$RESTORE_TMP_DIR"
  fi
}
trap cleanup EXIT

main() {
  require_root

  if [ "$#" -lt 1 ]; then
    log_error "Usage: zedbot restore <backup-file>"
    log_info "Available backups:"
    ls -1 "${ZEDBOT_BACKUP_DIR}"/zedbot-backup-*.tar.gz 2>/dev/null || log_info "  (none found in ${ZEDBOT_BACKUP_DIR})"
    exit 1
  fi

  local backup_file="$1"
  # Allow bare file names relative to the backups directory.
  if [ ! -f "$backup_file" ] && [ -f "${ZEDBOT_BACKUP_DIR}/${backup_file}" ]; then
    backup_file="${ZEDBOT_BACKUP_DIR}/${backup_file}"
  fi
  if [ ! -f "$backup_file" ]; then
    log_error "Backup file not found: $1"
    exit 1
  fi
  # Resolve to an absolute path now - later steps change the working
  # directory, which would break a caller-relative path.
  backup_file="$(readlink -f "$backup_file" 2>/dev/null || printf '%s' "$backup_file")"

  app_cd
  detect_compose_command

  log_warn "Restore is DESTRUCTIVE:"
  log_warn "  - The current .env will be replaced (a timestamped copy is kept next to it)."
  log_warn "  - The current PostgreSQL database will be overwritten."
  if ! confirm "Continue restoring from ${backup_file##*/}?" "n"; then
    log_info "Restore cancelled. Nothing was changed."
    exit 0
  fi

  ensure_directory "$ZEDBOT_BACKUP_DIR" 700
  RESTORE_TMP_DIR="$(mktemp -d "${ZEDBOT_BACKUP_DIR}/.restore-XXXXXX")"
  chmod 700 "$RESTORE_TMP_DIR"

  log_info "Extracting the backup archive ..."
  tar -xzf "$backup_file" -C "$RESTORE_TMP_DIR"

  if [ ! -f "${RESTORE_TMP_DIR}/.env" ] && [ ! -f "${RESTORE_TMP_DIR}/database.sql" ]; then
    log_error "This archive does not look like a ZED_BOT backup (no .env or database.sql inside)."
    exit 1
  fi

  log_info "Stopping application services ..."
  run_compose stop api bot worker 2>/dev/null || run_compose stop || true

  # 1. Configuration (.env)
  if [ -f "${RESTORE_TMP_DIR}/.env" ]; then
    if [ -f "$ZEDBOT_ENV_FILE" ]; then
      local kept
      kept="${ZEDBOT_ENV_FILE}.pre-restore.$(timestamp)"
      cp -a "$ZEDBOT_ENV_FILE" "$kept"
      chmod 600 "$kept"
      log_info "The current .env was saved to ${kept}."
    fi
    install -m 600 "${RESTORE_TMP_DIR}/.env" "$ZEDBOT_ENV_FILE"
    log_success ".env restored."
  else
    log_warn "The backup contains no .env - keeping the current configuration."
  fi

  load_env_if_exists

  log_info "Starting postgres and redis ..."
  run_compose up -d postgres redis
  if ! wait_for_service_healthy postgres 120; then
    log_error "postgres did not become healthy in time. Run 'zedbot doctor' and retry."
    exit 1
  fi

  local pg_user pg_db
  pg_user="${POSTGRES_USER:-zedbot}"
  pg_db="${POSTGRES_DB:-zedbot}"

  # PostgreSQL only reads POSTGRES_PASSWORD on first initialization, so after
  # restoring an older .env the password inside the (persistent) data volume
  # may differ. Re-align it with the restored .env. The password is passed via
  # stdin so it never shows up in process listings or logs.
  if [ -n "${POSTGRES_PASSWORD:-}" ]; then
    local pw_sql
    pw_sql="${POSTGRES_PASSWORD//"'"/"''"}"
    if ! run_compose exec -T postgres psql -q -U "$pg_user" -d postgres >/dev/null <<SQL
ALTER USER "${pg_user}" WITH PASSWORD '${pw_sql}';
SQL
    then
      log_warn "Could not synchronize the PostgreSQL password with the restored .env."
    fi
  fi

  # 2. Database
  if [ -f "${RESTORE_TMP_DIR}/database.sql" ]; then
    log_info "Restoring the PostgreSQL database '${pg_db}' ..."
    if run_compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" < "${RESTORE_TMP_DIR}/database.sql" >/dev/null; then
      log_success "Database restored."
    else
      log_error "The database restore failed. The dump may be incomplete; run 'zedbot doctor'."
      exit 1
    fi
  else
    log_warn "The backup contains no database dump - the database was left unchanged."
  fi

  log_info "Starting all services ..."
  run_compose up -d --remove-orphans

  log_info "Running health checks ..."
  bash "${SCRIPT_DIR}/doctor.sh" || log_warn "The doctor reported problems after the restore."

  log_success "Restore completed from: ${backup_file}"
}

main "$@"
