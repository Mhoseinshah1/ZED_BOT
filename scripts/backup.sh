#!/usr/bin/env bash
# =============================================================================
# ZED_BOT backup: archives .env and a PostgreSQL dump into
#   /opt/zedbot/backups/zedbot-backup-YYYYMMDD-HHMMSS.tar.gz
# Never prints secret values.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

TMP_BACKUP_DIR=""
PARTIAL_ARCHIVE=""

cleanup() {
  if [ -n "$TMP_BACKUP_DIR" ] && [ -d "$TMP_BACKUP_DIR" ]; then
    rm -rf "$TMP_BACKUP_DIR"
  fi
  # Never leave a half-written archive behind - it would look like a valid
  # backup.
  if [ -n "$PARTIAL_ARCHIVE" ] && [ -f "$PARTIAL_ARCHIVE" ]; then
    rm -f "$PARTIAL_ARCHIVE"
  fi
  return 0
}
trap cleanup EXIT

main() {
  require_root
  app_cd
  load_env_if_exists

  ensure_directory "$ZEDBOT_BACKUP_DIR" 700

  local ts archive
  ts="$(timestamp)"
  TMP_BACKUP_DIR="${ZEDBOT_BACKUP_DIR}/.tmp-${ts}-$$"
  archive="${ZEDBOT_BACKUP_DIR}/zedbot-backup-${ts}.tar.gz"
  mkdir -p "$TMP_BACKUP_DIR"
  chmod 700 "$TMP_BACKUP_DIR"

  log_info "Creating backup ${archive##*/} ..."

  # 1. Configuration (.env)
  if [ -f "$ZEDBOT_ENV_FILE" ]; then
    cp -a "$ZEDBOT_ENV_FILE" "${TMP_BACKUP_DIR}/.env"
    chmod 600 "${TMP_BACKUP_DIR}/.env"
    log_info "Configuration (.env) added to the backup."
  else
    log_warn "No .env file found - skipping the configuration backup."
  fi

  # 2. PostgreSQL dump (only when the container is running)
  if compose_service_running postgres; then
    local pg_user pg_db
    pg_user="${POSTGRES_USER:-zedbot}"
    pg_db="${POSTGRES_DB:-zedbot}"
    log_info "Dumping PostgreSQL database '${pg_db}' ..."
    if run_compose exec -T postgres pg_dump --clean --if-exists -U "$pg_user" -d "$pg_db" > "${TMP_BACKUP_DIR}/database.sql"; then
      chmod 600 "${TMP_BACKUP_DIR}/database.sql"
      log_success "Database dump completed."
    else
      log_error "The PostgreSQL dump failed - aborting to avoid an incomplete backup."
      exit 1
    fi
  else
    log_warn "The postgres container is not running - skipping the database dump."
  fi

  # 3. Metadata (no secrets)
  {
    printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'git_commit=%s\n' "$(git -C "$ZEDBOT_APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    printf 'hostname=%s\n' "$(hostname)"
  } > "${TMP_BACKUP_DIR}/backup-info.txt"

  # Write to a temp name and move into place only when complete, so a failed
  # tar can never leave a corrupt zedbot-backup-*.tar.gz at the final path.
  PARTIAL_ARCHIVE="${archive}.partial"
  tar -czf "$PARTIAL_ARCHIVE" -C "$TMP_BACKUP_DIR" .
  chmod 600 "$PARTIAL_ARCHIVE"
  mv "$PARTIAL_ARCHIVE" "$archive"
  PARTIAL_ARCHIVE=""

  rm -rf "$TMP_BACKUP_DIR"
  TMP_BACKUP_DIR=""

  log_success "Backup created: ${archive}"
}

main "$@"
