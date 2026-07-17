#!/usr/bin/env bash
# =============================================================================
# ZED_BOT backup: archives .env and a PostgreSQL dump into
#   /opt/zedbot/backups/zedbot_backup_YYYY-MM-DD_HH-mm-ss.tar.gz
#
# When BACKUP_ENCRYPTION_PASSWORD is set in .env the archive is encrypted
# with AES-256 (openssl, PBKDF2) and gets the .enc suffix. The password is
# passed via the environment - it never appears on a command line or in logs.
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
  load_env

  # Host backup location (BACKUP_DIR is the IN-CONTAINER path since the ops
  # phase; relocate host backups via ZEDBOT_BACKUP_DIR). The shared dir is
  # runtime-user-owned 750; the archive itself stays root-owned 600 because
  # it contains .env.
  local backup_dir="$ZEDBOT_BACKUP_DIR"
  ensure_backup_dir_permissions "$backup_dir"

  local ts archive
  ts="$(date +%Y-%m-%d_%H-%M-%S)"
  TMP_BACKUP_DIR="${backup_dir}/.tmp-${ts}-$$"
  archive="${backup_dir}/zedbot_backup_${ts}.tar.gz"
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
  # tar can never leave a corrupt archive at the final path.
  PARTIAL_ARCHIVE="${archive}.partial"
  tar -czf "$PARTIAL_ARCHIVE" -C "$TMP_BACKUP_DIR" .
  chmod 600 "$PARTIAL_ARCHIVE"

  if [ -n "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
    log_info "Encrypting the backup (AES-256) ..."
    local encrypted="${archive}.enc"
    export BACKUP_ENCRYPTION_PASSWORD
    if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -in "$PARTIAL_ARCHIVE" -out "${encrypted}.partial" \
      -pass env:BACKUP_ENCRYPTION_PASSWORD; then
      chmod 600 "${encrypted}.partial"
      mv "${encrypted}.partial" "$encrypted"
      rm -f "$PARTIAL_ARCHIVE"
      PARTIAL_ARCHIVE=""
      rm -rf "$TMP_BACKUP_DIR"
      TMP_BACKUP_DIR=""
      log_success "Encrypted backup created: ${encrypted}"
      log_info "Restoring requires BACKUP_ENCRYPTION_PASSWORD - keep a copy of it off this server."
    else
      rm -f "${encrypted}.partial"
      log_error "Backup encryption failed - no backup was written."
      exit 1
    fi
  else
    mv "$PARTIAL_ARCHIVE" "$archive"
    PARTIAL_ARCHIVE=""
    rm -rf "$TMP_BACKUP_DIR"
    TMP_BACKUP_DIR=""
    log_success "Backup created: ${archive}"
    log_info "Tip: set BACKUP_ENCRYPTION_PASSWORD in .env to encrypt future backups."
  fi
}

main "$@"
