#!/usr/bin/env bash
# =============================================================================
# ZED_BOT database-only backup:
#   /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.sql.gz
#
# The filename format matches the in-bot Phase 35 backups exactly, so the
# admin panel lists CLI-created files too. DB only - the .env file is NEVER
# included here (the update safety archive in backup.sh covers that).
# No password is echoed: pg_dump runs inside the postgres container over the
# local socket; only the (non-secret) user/db names appear on the command
# line. A failed or empty dump deletes the partial file.
#
# Optional retention: when BACKUP_RETENTION_DAYS is a positive number, files
# matching zedbot-db-*.sql.gz older than that many days are removed after a
# successful backup. Nothing else is ever deleted.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PARTIAL_FILE=""

cleanup() {
  # Never leave a half-written dump behind - it would look like a valid backup.
  if [ -n "$PARTIAL_FILE" ] && [ -f "$PARTIAL_FILE" ]; then
    rm -f "$PARTIAL_FILE"
  fi
  return 0
}
trap cleanup EXIT

main() {
  require_root
  app_cd
  load_env_if_exists
  detect_compose_command

  local backup_dir="${BACKUP_DIR:-$ZEDBOT_BACKUP_DIR}"
  ensure_directory "$backup_dir" 700

  if ! compose_service_running postgres; then
    log_error "The postgres container is not running - start it first: zedbot start"
    exit 1
  fi

  local ts file
  ts="$(date +%Y%m%d-%H%M%S)"
  file="${backup_dir}/zedbot-db-${ts}.sql.gz"
  # Never overwrite an existing backup (same-second re-run).
  while [ -e "$file" ]; do
    sleep 1
    ts="$(date +%Y%m%d-%H%M%S)"
    file="${backup_dir}/zedbot-db-${ts}.sql.gz"
  done

  local pg_user pg_db
  pg_user="${POSTGRES_USER:-zedbot}"
  pg_db="${POSTGRES_DB:-zedbot}"

  log_info "Creating database backup ${file##*/} ..."
  PARTIAL_FILE="$file"
  # pipefail: a failing pg_dump fails the pipeline; the EXIT trap removes
  # the partial file.
  run_compose exec -T postgres pg_dump --clean --if-exists -U "$pg_user" -d "$pg_db" \
    | gzip > "$file"

  if [ ! -s "$file" ]; then
    log_error "The database dump is empty - removing the partial file."
    exit 1
  fi
  chmod 600 "$file"
  PARTIAL_FILE=""
  log_success "Backup created: ${file} ($(du -h "$file" | cut -f1))"

  # Optional retention cleanup - matching backup files only.
  local retention="${BACKUP_RETENTION_DAYS:-}"
  if printf '%s' "$retention" | grep -Eq '^[0-9]+$' && [ "$retention" -gt 0 ]; then
    local deleted=0 old
    while IFS= read -r old; do
      rm -f "$old"
      deleted=$((deleted + 1))
    done < <(find "$backup_dir" -maxdepth 1 -type f -name 'zedbot-db-*.sql.gz' \
      -mtime +"$retention" 2>/dev/null)
    if [ "$deleted" -gt 0 ]; then
      log_info "Retention cleanup removed ${deleted} backup(s) older than ${retention} day(s)."
    fi
  fi
}

main "$@"
