#!/usr/bin/env bash
# =============================================================================
# ZED_BOT restore: restores .env and the PostgreSQL database from a backup
# archive created by backup.sh (plain .tar.gz or encrypted .tar.gz.enc).
#
# Usage: zedbot restore [backup-file]
#        - without an argument, lists the available backups and asks which
#          one to restore
#        - bare file names are resolved inside /opt/zedbot/backups
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
  return 0
}
trap cleanup EXIT

# Prints the available backup archives (new and legacy naming), newest first.
list_backups() {
  local backup_dir="$1"
  find "$backup_dir" -maxdepth 1 -type f \
    \( -name 'zedbot_backup_*.tar.gz' -o -name 'zedbot_backup_*.tar.gz.enc' \
    -o -name 'zedbot-backup-*.tar.gz' -o -name 'zedbot-backup-*.tar.gz.enc' \) \
    2>/dev/null | sort -r
}

# Interactively picks a backup from the list; prints the chosen path.
choose_backup() {
  local backup_dir="$1" backups=() choice
  mapfile -t backups < <(list_backups "$backup_dir")
  if [ "${#backups[@]}" -eq 0 ]; then
    log_error "No backups found in ${backup_dir}."
    log_info "Create one first with: zedbot backup"
    exit 1
  fi
  log_info "Available backups in ${backup_dir} (newest first):" >&2
  local i
  for i in "${!backups[@]}"; do
    printf '  [%d] %s\n' "$((i + 1))" "${backups[$i]##*/}" >&2
  done
  if ! ( : </dev/tty ) 2>/dev/null; then
    log_error "No terminal available to choose a backup. Pass the file explicitly: zedbot restore <backup-file>"
    exit 1
  fi
  read -r -p "Number of the backup to restore [1-${#backups[@]}]: " choice </dev/tty || choice=""
  if ! printf '%s' "$choice" | grep -Eq '^[0-9]+$' || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#backups[@]}" ]; then
    log_error "Invalid selection: '${choice}'"
    exit 1
  fi
  printf '%s' "${backups[$((choice - 1))]}"
}

main() {
  require_root
  load_env
  local backup_dir="${BACKUP_DIR:-$ZEDBOT_BACKUP_DIR}"

  local backup_file="${1:-}"
  if [ -z "$backup_file" ]; then
    backup_file="$(choose_backup "$backup_dir")"
  fi
  # Allow bare file names relative to the backups directory.
  if [ ! -f "$backup_file" ] && [ -f "${backup_dir}/${backup_file}" ]; then
    backup_file="${backup_dir}/${backup_file}"
  fi
  if [ ! -f "$backup_file" ]; then
    log_error "Backup file not found: ${1:-<none>}"
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

  ensure_directory "$backup_dir" 700
  RESTORE_TMP_DIR="$(mktemp -d "${backup_dir}/.restore-XXXXXX")"
  chmod 700 "$RESTORE_TMP_DIR"

  # Decrypt when the archive is encrypted.
  local tarball="$backup_file"
  case "$backup_file" in
    *.enc)
      if [ -z "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
        log_warn "This backup is encrypted and BACKUP_ENCRYPTION_PASSWORD is not set in .env."
        if ( : </dev/tty ) 2>/dev/null; then
          read -r -s -p "Backup encryption password (input hidden): " BACKUP_ENCRYPTION_PASSWORD </dev/tty || BACKUP_ENCRYPTION_PASSWORD=""
          printf '\n' >&2
        fi
        if [ -z "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
          log_error "No password available - cannot decrypt this backup."
          exit 1
        fi
      fi
      log_info "Decrypting the backup archive ..."
      tarball="${RESTORE_TMP_DIR}/backup.tar.gz"
      export BACKUP_ENCRYPTION_PASSWORD
      if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in "$backup_file" -out "$tarball" \
        -pass env:BACKUP_ENCRYPTION_PASSWORD; then
        log_error "Decryption failed - wrong password or corrupted archive."
        exit 1
      fi
      ;;
  esac

  log_info "Extracting the backup archive ..."
  tar -xzf "$tarball" -C "$RESTORE_TMP_DIR"

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

  load_env

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
